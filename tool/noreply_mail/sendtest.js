// One test message through auth's own mail settings.
//   node sendtest.js <to>     (run from auth's app folder on the box)
const c = require(process.cwd() + '/src/config').mail;
require(process.cwd() + '/node_modules/nodemailer')
  .createTransport({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.password } })
  .sendMail({
    from: c.from,
    to: process.argv[2],
    subject: 'auth.vesopa.com mail test',
    text: `Sent by auth.vesopa.com through ${c.user} on ${c.host}:${c.port}.`,
  })
  .then((info) => console.log('accepted:', info.accepted.join(','), '|', info.response))
  .catch((error) => console.log('FAILED:', error.message));
