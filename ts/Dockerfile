FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src/ src/
RUN npx tsc
CMD ["node", "dist/index.js"]
