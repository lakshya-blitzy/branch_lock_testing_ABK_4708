const express = require('express');
const app = express();

const hostname = '127.0.0.1';
const port = 3000;

app.get('/', (req, res) => res.status(200).type('text/plain').send('Hello, World!\n'));
app.get('/evening', (req, res) => res.status(200).type('text/plain').send('Good evening'));

app.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
