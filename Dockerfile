#Use and existing docker image as a base
FROM node:15-alpine3.13
WORKDIR '/app'
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm","run","dev"]
