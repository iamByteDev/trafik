FROM node:20-slim
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of your code
COPY . .

# Set the port and start the app
ENV PORT=3001
EXPOSE 3001
CMD ["node", "backend.js"]
