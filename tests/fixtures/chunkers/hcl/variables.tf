variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "eu-west-1"
}

variable "project" {
  type = string
}

variable "instance_type" {
  description = "EC2 instance size"
  type        = string
  default     = "t3.small"
  validation {
    condition     = contains(["t3.small", "t3.medium"], var.instance_type)
    error_message = "Unsupported instance type."
  }
}

variable "vpc_cidr" { default = "10.0.0.0/16" }
