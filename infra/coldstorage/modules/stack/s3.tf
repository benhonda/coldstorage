# The ColdStorage vault — one S3 bucket per env, written to directly as Glacier Deep
# Archive by the daemon (it sets StorageClass=DEEP_ARCHIVE on upload, so there is no
# lifecycle transition rule to add). Objects live under the `blobs/` prefix.

data "aws_caller_identity" "current" {}

locals {
  # Globally-unique, deterministic, env-keyed. Account-id suffix avoids name collisions
  # without a random suffix. Wire this into the daemon's COLDSTORE_BUCKET (see outputs).
  bucket_name = "${var.project_name}-${var.env}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "vault" {
  bucket = local.bucket_name
}

# Lock it down — never public. This is a private vault.
resource "aws_s3_bucket_public_access_block" "vault" {
  bucket                  = aws_s3_bucket.vault.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Disable ACLs entirely (modern default) — ownership is the bucket owner, full stop.
resource "aws_s3_bucket_ownership_controls" "vault" {
  bucket = aws_s3_bucket.vault.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioning ON: this is the "stuff you can't lose" vault — insurance against an
# accidental overwrite/delete bug. Blobs are content-addressed + the daemon is
# idempotent, so in practice this adds ~no extra versions.
#
# Noncurrent versions are NOT expired in general — nothing gets auto-deleted from the
# vault — with exactly one exception: `expire-reclaimable-blobs` below expires the
# noncurrent version of a blob the daemon has explicitly tagged as reclaimable. Without
# that exception `expiration` on a versioned bucket only hides the object behind a delete
# marker, so the user's quota would free while we kept paying for the bytes for ever.
resource "aws_s3_bucket_versioning" "vault" {
  bucket = aws_s3_bucket.vault.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption (AES256/SSE-S3, free). Belt-and-suspenders only — the daemon
# already client-side encrypts every blob with AES-GCM before upload. No KMS (redundant
# with client-side crypto + adds cost/complexity).
resource "aws_s3_bucket_server_side_encryption_configuration" "vault" {
  bucket = aws_s3_bucket.vault.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Lifecycle rules. (1) reap orphaned multipart parts (never-completed uploads = garbage that accrues
# storage cost). (2+3) expire blobs the daemon has explicitly tagged reclaimable, and the delete markers
# that leaves behind. A completed object is auto-deleted ONLY when the daemon tagged it — i.e. only once
# every file inside it was deleted by the user. Nothing else in the vault is ever removed automatically.
resource "aws_s3_bucket_lifecycle_configuration" "vault" {
  bucket = aws_s3_bucket.vault.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_days
    }
  }

  # ── Reclaiming deleted data ────────────────────────────────────────────────────────────────────────
  # Quota is measured from a live listing of the user's prefix, so bytes nothing references still consume
  # the plan they paid for. Without this rule a deleted file frees nothing, ever: the vault fills with the
  # ghosts of things the user removed and eventually refuses new deposits while showing a tree half its size.
  #
  # **The daemon tags; only this rule deletes.** It runs with the bucket's own credentials, which the client
  # never holds. That is the entire point of expressing reclamation as a tag: the daemon lives on the user's
  # Mac with the user's credentials, and `s3:DeleteObject` there would let anything that compromises that
  # machine erase the archive outright — the precise failure this product exists to prevent. A compromised
  # client can, at worst, queue a deletion that is visible in the object's tags.
  #
  # Expiry is set TO the 180-day minimum, not earlier — so the object goes at the moment it stops being
  # billable and never before. Giving the user their space back sooner than that is handled separately, in
  # `Journal.reclaimedCreditBytes`, which credits at eligibility (AWS stops charging then, even if the sweep
  # runs later). Keep the two straight: this rule controls OUR cost, the credit controls THEIR quota.
  #
  # The tag spelling is duplicated in `S3Store.reapTagKey`. A mismatch is silent — the object gets tagged,
  # this rule never matches, and the bytes bill forever while the journal believes they're gone.
  rule {
    id     = "expire-reclaimable-blobs"
    status = "Enabled"

    filter {
      tag {
        key   = "coldstorage-reap"
        value = "true"
      }
    }

    # Measured from object CREATION, not from when the tag was applied — S3 offers no "days since tagged".
    # Any blob old enough to be worth reclaiming is already past this, so in practice the tag is the trigger
    # and expiry lands on the next daily lifecycle sweep.
    expiration {
      days = var.reclaimable_blob_expiry_days
    }

    # ── THIS BUCKET IS VERSIONED, which changes what `expiration` means ──────────────────────────────
    # On a versioned bucket `expiration` does NOT delete bytes. It writes a delete marker and demotes the
    # object to a NONCURRENT version — which the versioning block above deliberately never expires. The key
    # stops appearing in ListObjectsV2, so the user's quota frees, while the bytes stay and keep billing.
    # That is the worst possible failure for this feature: it hands back space we are still paying for,
    # forever, which is precisely the churn hole the 180-day alignment exists to close.
    #
    # So the reap rule must expire the noncurrent version too. 1 day, not 0: it keeps a brief window in
    # which a mistaken reap is still recoverable from the noncurrent version, and Deep Archive's 180-day
    # minimum is already satisfied by the `expiration` above, so this adds no cost.
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  # Delete markers left behind once the noncurrent version is gone. They hold no data and cost nothing, but
  # an accumulating field of them slows every listing — and the quota gate runs a full listing. Separate
  # rule because a delete marker carries no tags, so the reap rule's tag filter can never match one.
  rule {
    id     = "expire-orphaned-delete-markers"
    status = "Enabled"

    filter {
      prefix = "blobs/"
    }

    expiration {
      expired_object_delete_marker = true
    }
  }
}
