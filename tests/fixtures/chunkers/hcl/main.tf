terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

locals {
  name_prefix = "${var.project}-${terraform.workspace}"
  tags = {
    Project = var.project
    Owner   = "platform"
  }
}

# Static assets bucket
resource "aws_s3_bucket" "assets" {
  bucket = "${local.name_prefix}-assets"
  tags   = local.tags
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_iam_policy_document" "assets_read" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]
  }
}

module "network" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.8.1"
  name    = local.name_prefix
  cidr    = var.vpc_cidr
}

resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type

  user_data = <<-EOT
    #!/bin/bash
    echo "resource \"fake\" { inside heredoc }"
  EOT

  lifecycle {
    create_before_destroy = true
  }
}
