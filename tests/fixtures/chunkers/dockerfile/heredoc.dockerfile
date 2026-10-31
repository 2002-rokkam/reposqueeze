# escape=`
FROM mcr.microsoft.com/windows/servercore:ltsc2022 AS base
SHELL ["powershell", "-Command"]

RUN Write-Host 'installing' `
    ; Install-PackageProvider -Name NuGet -Force

FROM base AS app
COPY <<EOF /app/config.ini
[server]
port = 8080
# comment inside the heredoc
EOF
RUN <<EOT
echo "step one"
echo "FROM is not an instruction here"
EOT
ONBUILD COPY . /src
