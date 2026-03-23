FROM oven/bun:latest
WORKDIR /app
COPY . .
ENV PORT=3001
EXPOSE 3001
CMD ["bun", "run", "backend.js"]