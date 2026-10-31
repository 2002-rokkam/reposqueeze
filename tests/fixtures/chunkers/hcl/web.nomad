job "web" {
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 2

    network {
      port "http" {
        to = 8080
      }
    }

    task "server" {
      driver = "docker"
      config {
        image = "acme/web:1.4"
        ports = ["http"]
      }
      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
