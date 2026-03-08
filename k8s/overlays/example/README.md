Copy this directory to `k8s/overlays/local/` and edit only the local copy.

Fields to replace in the local overlay:

- `patch-configmap.yaml`
  - `BASE_URL`
  - `GOOGLE_PROJECT_ID`
- `patch-ingress.yaml`
  - ingress host
  - TLS host
  - TLS secret name if needed
- `patch-deployment.yaml`
  - image reference, for example `ghcr.io/<owner>/vivint-security-view:latest`

Apply order for a real deployment:

1. Copy `k8s/apply-secrets.example.ps1` to `k8s/apply-secrets.ps1`
2. Fill in:
   - GitHub username
   - GHCR read-packages token
   - Google client id/secret
   - bridge auth user/pass
   - stream token
   - path to your secret `settings.json`
3. Run `k8s/apply-secrets.ps1`
4. Apply the local overlay:
   - `kubectl apply -k k8s/overlays/local`

Keep `k8s/overlays/local/`, `k8s/apply-secrets.ps1`, and the public bridge `settings.json` out of git.
