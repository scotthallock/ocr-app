FROM node:18

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3434

CMD ["node", "app.js"]