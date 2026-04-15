# Use Node.js 18 LTS
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all deps (TypeScript lives in devDependencies; root `npm run build` runs `tsc`)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Drop devDependencies for a smaller runtime image (keeps compiled `dist/`)
RUN npm prune --omit=dev

# Expose the port
EXPOSE 8000

# Set environment to production
ENV NODE_ENV=production

# Default: main.ts. Railway overrides via railway.json to `npm run start:vapi`.
CMD ["npm", "start"]