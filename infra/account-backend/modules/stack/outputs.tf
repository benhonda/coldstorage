output "vercel_role_arn" {
  value       = aws_iam_role.vercel.arn
  description = "The OIDC role Vercel assumes for this project/env (dormant until this service makes an AWS call)."
}
