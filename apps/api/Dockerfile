# API + worker image (same code, different command). Build context: repository root.
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api && mkdir -p apps/api/node_modules

FROM deps AS build
COPY apps/api apps/api
RUN cd apps/api && npx prisma generate && npx nest build

FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --omit=dev && mkdir -p apps/api/node_modules && npm cache clean --force

FROM base AS runtime
# TeX Live: compiles YOUR LaTeX resume exactly as designed (pdflatex/xelatex/lualatex).
# texlive-fonts-extra is large (~1 GB) but covers fontawesome & friends used by many resume templates;
# build with --build-arg TEX_FONTS_EXTRA=false for a smaller image.
ARG TEX_FONTS_EXTRA=true
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
      texlive-xetex texlive-luatex texlive-pictures lmodern fontconfig \
      $( [ "$TEX_FONTS_EXTRA" = "true" ] && echo texlive-fonts-extra ) \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Default profile baked in; docker-compose mounts ./candidate over it so edits persist.
COPY candidate ./candidate
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /app/candidate /data
USER node
WORKDIR /app/apps/api
EXPOSE 4000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["api"]
