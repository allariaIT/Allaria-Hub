FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
EXPOSE 3098
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
