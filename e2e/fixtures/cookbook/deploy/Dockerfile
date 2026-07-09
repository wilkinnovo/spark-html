FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV NODE_ENV=production
# spark-ssr fails hard in production if auth is configured without a secret —
# provide it: fly secrets set SESSION_SECRET=… / railway variables set …
EXPOSE 3000
CMD ["bun", "x", "spark-ssr", "start", "--port", "3000"]
