output "bucket_name" {
  description = "Name of the assets bucket"
  value       = aws_s3_bucket.assets.bucket
}

output "web_ip" {
  value = aws_instance.web.public_ip
}

// a comment with a { brace
/* block comment with } brace */
output "vpc_id" { value = module.network.vpc_id }
