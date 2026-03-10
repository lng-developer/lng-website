# # ---- Base ----
# FROM node:20-alpine AS base
# WORKDIR /app
# RUN apk add --no-cache python3 make g++ vips-dev

# # ---- Dependencies ----
# FROM base AS deps
# COPY package.json package-lock.json ./
# RUN npm ci --omit=dev

# # ---- Development ----
# FROM base AS dev
# COPY package.json package-lock.json ./
# RUN npm ci
# COPY . .
# EXPOSE 5000
# CMD ["npx", "nodemon", "server.js"]

# # ---- Production ----
# FROM node:20-alpine AS production
# WORKDIR /app
# RUN apk add --no-cache vips
# COPY --from=deps /app/node_modules ./node_modules
# COPY . .

# # Non-root user
# RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# USER appuser

# EXPOSE 5000
# ENV NODE_ENV=production
# CMD ["node", "server.js"]
