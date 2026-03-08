$namespace = "vivint-bridge"

# Copy this file to apply-secrets.ps1 and fill in the real values locally.
$googleClientId = "paste-google-client-id"
$googleClientSecret = "paste-google-client-secret"
$googleAuthUser = "local-bridge-admin"
$googleAuthPass = "change-me"
$streamToken = "change-me"
$ghcrServer = "ghcr.io"
$ghcrUsername = "paste-github-username"
$ghcrToken = "paste-ghcr-read-packages-token"
$settingsFile = ".\k8s\settings.public.json"

kubectl create namespace $namespace --dry-run=client -o yaml | kubectl apply -f -

kubectl -n $namespace create secret docker-registry ghcr-pull-secret `
  --docker-server=$ghcrServer `
  --docker-username=$ghcrUsername `
  --docker-password=$ghcrToken `
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n $namespace create secret generic vivint-bridge-secrets `
  --from-literal=GOOGLE_CLIENT_ID=$googleClientId `
  --from-literal=GOOGLE_CLIENT_SECRET=$googleClientSecret `
  --from-literal=GOOGLE_AUTH_USER=$googleAuthUser `
  --from-literal=GOOGLE_AUTH_PASS=$googleAuthPass `
  --from-literal=STREAM_TOKEN=$streamToken `
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n $namespace create secret generic vivint-bridge-cameras `
  --from-file=settings.json=$settingsFile `
  --dry-run=client -o yaml | kubectl apply -f -
