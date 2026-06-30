# The daemon's identity. ColdStorage runs as a Mac daemon (launchd), NOT on Vercel —
# so this is a least-privilege IAM user (not a Vercel-OIDC role). The daemon picks the
# keys up via the AWS SDK default credential provider chain (env vars / ~/.aws/credentials),
# which on macOS the app populates from the Keychain. Multi-user later → Cognito Identity
# Pool (deferred commercial layer); the SDK credential seam makes that an edge swap.

resource "aws_iam_user" "daemon" {
  name = "${var.project_name}-${var.env}-daemon"
  path = "/coldstorage/"
}

# Least privilege, grounded in the daemon's ACTUAL S3 calls (verified against the Swift
# source + AWS docs), scoped to the `blobs/` prefix only:
#   s3:PutObject    → CreateMultipartUpload, UploadPart, CompleteMultipartUpload
#   s3:GetObject    → HeadObject (verify + thaw-state), ListParts (resume), ranged GET (restore)
#   s3:RestoreObject→ Glacier Deep Archive thaw
# Not granted (not used): AbortMultipartUpload, ListBucket, DeleteObject.
data "aws_iam_policy_document" "daemon" {
  statement {
    sid    = "BlobReadWriteRestore"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:RestoreObject",
    ]
    resources = ["${aws_s3_bucket.vault.arn}/blobs/*"]
  }
}

resource "aws_iam_user_policy" "daemon" {
  name   = "${var.project_name}-${var.env}-daemon-s3"
  user   = aws_iam_user.daemon.name
  policy = data.aws_iam_policy_document.daemon.json
}

# Long-lived access key for the daemon. The secret lands in (encrypted, team-private)
# terraform-state-sensitive and is exposed once via a sensitive output — grab it after
# apply, store it in the Mac Keychain, done. Rotate by tainting this resource.
# (V1/dogfood tradeoff: simplest correct path. Cognito removes long-lived keys later.)
resource "aws_iam_access_key" "daemon" {
  user = aws_iam_user.daemon.name
}
