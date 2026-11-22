// Mint a test JWT signed with local/lambda.env's JWT_SECRET, for local/invoke.sh.
//   node local/mint-token.js player <username>   (party id mock-<username>, chain "mock")
//   node local/mint-token.js operator            (root operator of tenant "mock")
const jwt = require('jsonwebtoken');
const fs = require('fs');
const env = fs.readFileSync(`${__dirname}/lambda.env`, 'utf8');
const secret = (/^JWT_SECRET=(.*)$/m.exec(env) || [])[1]?.trim();
if (!secret) { console.error('JWT_SECRET is empty in local/lambda.env'); process.exit(1); }
const [kind = 'player', name = 'ana'] = process.argv.slice(2);
const who = kind === 'operator'
  ? { id: 2, username: 'opadmin', identifier: 'opadmin', metadata: { partyId: 'mock', chain: '', partyType: 'organization' }, fullChain: 'mock' }
  : { id: 1, username: name, identifier: name, partyId: `mock-${name}`, metadata: { partyId: `mock-${name}`, chain: 'mock', partyType: 'person' }, fullChain: `mock-mock-${name}` };
process.stdout.write(jwt.sign(who, secret, { algorithm: 'HS256', expiresIn: '2h' }));
