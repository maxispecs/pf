provider "aws" {
  region = "us-west-2"
}
resource "aws_lambda_function" "x" {
  function_name = "billing-hello"
}
resource "aws_db_instance" "db" {}
