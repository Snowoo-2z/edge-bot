# Render (detecteur de buildpack Node) : « web », pas « worker » — le plan
# gratuit n'autorise que les services web, et un service web doit ecouter $PORT.
# C'est exactement ce que fait la sonde dans src/core/health.ts.
web: node dist/index.js
