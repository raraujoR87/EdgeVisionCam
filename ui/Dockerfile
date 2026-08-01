# Stage 1: Build the Next.js application
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependency files
COPY package*.json ./
RUN npm ci

# Copy code and build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_LOCAL_ONLY=true
RUN npm run build

# Stage 2: Production runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy only the built assets and node_modules necessary to run Next.js
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules

# next.config.js precisa existir em runtime: e ele que desliga optimizeFonts.
# Sem o arquivo, `next start` roda com a configuracao padrao e tenta buscar
# fontes na rede — era essa a causa do crash offline que vinha sendo contornado
# com um .next/server/font-manifest.json falso, agora dispensavel.
COPY --from=builder /app/next.config.js ./

EXPOSE 3000

# Run in production mode
CMD ["npm", "start"]
