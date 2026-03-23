FROM node:20-slim
WORKDIR /app
# Copy both package files to install dependencies first
COPY package*.json ./
RUN npm install
# Copy the rest of your files (backend.js, etc.)
COPY . .
EXPOSE 3001
CMD ["node", "backend.js"]
