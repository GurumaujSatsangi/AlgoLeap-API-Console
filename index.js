import express from 'express';
import bodyParser from 'body-parser';
import session from 'express-session';
import passport from 'passport';
import GoogleStrategy from 'passport-google-oauth2';
import env from 'dotenv';


const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.listen(3000, () => {
  console.log('Server is running on port 3000');
});

app.get('/home', (req, res) => {
  res.render('home.ejs');
});
app.get('/', (req, res) => {
  res.redirect('/home');
});