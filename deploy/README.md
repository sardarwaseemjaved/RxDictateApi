# Deploying to the Oracle server

One Oracle Cloud VM runs everything: nginx takes HTTPS on 443 and passes it to
the API on 127.0.0.1:3000, which pm2 keeps alive. MongoDB runs on the same box
(or in Atlas). Code is built on a developer's machine and pushed with
[release.sh](release.sh). The repo has no git remote, so the server never pulls.

You need:

- SSH access to the VM. The user is `ubuntu` on Ubuntu images and `opc` on
  Oracle Linux. The commands below are for Ubuntu; the differences for Oracle
  Linux are at the end.
- A domain name with an A record pointing at the VM's public IP, for example
  `api.yourclinic.pk`. The app needs HTTPS: Android and iOS refuse plain
  `http://` by default, and Let's Encrypt needs a name to issue a certificate.
- An OpenAI API key, for dictation.
- A decision about sign-in codes. Read the next section first.

## Sign-in codes: read this first

With `NODE_ENV=production`, **nobody can sign in yet.** The only SMS provider,
`log`, sends nothing. It records that a code was "queued" and never records
the code itself. The code is not returned in the response either, and
`OTP_FIXED_CODE` is ignored in production. That is all deliberate, but it means
a real SMS gateway has to be wired in before doctors can use the server. The
gateway is a second provider in
[src/core/sms/index.ts](../src/core/sms/index.ts), and nothing else in the
codebase changes.

There are two ways to deploy before the gateway exists:

- **Testing the app against a real server:** set `NODE_ENV=development` and
  `OTP_FIXED_CODE=123456`. Every number signs in with that code, and codes also
  come back in responses as `devCode`. That means anybody who knows a phone
  number can sign in as its owner. **Use test data only, never real patients.**
- **Real doctors:** add the SMS gateway first, then deploy with
  `NODE_ENV=production`.

## One-time setup

### 0. Check the server

```sh
cat /etc/os-release | head -2   # Ubuntu or Oracle Linux
uname -m                        # aarch64 = Ampere (ARM), x86_64 = AMD/Intel
free -h                         # RAM
node --version; which node
```

If the VM has less than 2 GB of RAM (for example the free `E2.1.Micro`), don't
run MongoDB on it. Use Atlas instead (step 3).

### 1. Open ports 80 and 443

On Oracle Cloud the ports have to be opened in two places.

**In the Oracle Cloud console:** go to Networking → Virtual Cloud Networks →
your VCN → the VM's subnet → its Security List. Add two ingress rules, both
with source `0.0.0.0/0` and protocol TCP: one for destination port `80`, one
for `443`.

**On the VM:** Oracle's Ubuntu images ship with an iptables rule that rejects
everything except SSH. Insert the new rules above that REJECT rule:

```sh
sudo iptables -L INPUT --line-numbers         # note the number of the REJECT line, e.g. 6
sudo iptables -I INPUT 6 -p tcp -m state --state NEW --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -p tcp -m state --state NEW --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Do not open 3000. The only way in should be through nginx.

### 2. Node, yarn, pm2

Node 20 reached end-of-life on 30 April 2026 and no longer gets security
fixes. The API does run on it, because every production dependency accepts 20.
But CI and the Dockerfile both use 22, so install 22:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
sudo npm install -g yarn pm2
```

`release.sh` runs `yarn` and `pm2` over a non-interactive SSH session. If
`which node` points into `~/.nvm`, those commands won't find Node, so install
it this way instead.

### 3. MongoDB

**On this VM.** These commands install MongoDB 8.0, which works on both ARM
and x86. By default it listens on localhost only.

```sh
sudo apt-get install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt-get update && sudo apt-get install -y mongodb-org
sudo systemctl enable --now mongod
```

This database holds patient records, so give it a password. First generate
one:

```sh
openssl rand -hex 24
```

Create a user for the API. `passwordPrompt()` asks for the password, so it
stays out of the shell history:

```sh
mongosh --quiet --eval 'db.getSiblingDB("admin").createUser({user: "clinic", pwd: passwordPrompt(), roles: [{role: "readWrite", db: "clinic-api"}]})'
```

Then turn on authentication. Add these lines to `/etc/mongod.conf`:

```yaml
security:
  authorization: enabled
```

Then restart MongoDB:

```sh
sudo systemctl restart mongod
```

**Or in MongoDB Atlas.** Create a cluster in Mumbai (`ap-south-1`), which is
the closest region. Add the VM's public IP under Network Access, and use the
`mongodb+srv://` connection string as `MONGODB_URL`.

### 4. The app directory and `.env`

```sh
sudo mkdir -p /srv/clinic-api && sudo chown "$USER" /srv/clinic-api
nano /srv/clinic-api/.env
chmod 600 /srv/clinic-api/.env
```

Here is what to put in `.env`. Every variable is described in the
[README](../README.md#environment), and `src/config/config.ts` refuses to
boot if one is missing or wrong.

```sh
NODE_ENV=production            # or development, see "Sign-in codes" above
PORT=3000
TRUST_PROXY=1                  # nginx is in front; without this every user shares one rate limit

MONGODB_URL=mongodb://clinic:<password>@127.0.0.1:27017/clinic-api?authSource=admin
JWT_SECRET=<output of: openssl rand -hex 32>

# Required in production. The mobile app sends no Origin, so this matters only
# for a web portal. With no portal yet, the API's own URL satisfies the check.
CORS_ORIGINS=https://api.yourclinic.pk
# Download links are built from this. Unset, it is the VM's private 10.x
# address, which no phone can reach.
PUBLIC_API_URL=https://api.yourclinic.pk

STT_PROVIDER=openai
LLM_PROVIDER=openai
OPENAI_API_KEY=<key>

APP_NAME=<what the app is called in the store>
SMS_SENDER_ID=<the clinic name in a text>
```

**Storage.** With the default `local` driver, dictation audio and print files
live in `/srv/clinic-api/.storage`. That is enough to start with, with one
gap: lab report uploads need `STORAGE_DRIVER=s3`, and until then they answer
`STORAGE_UNAVAILABLE`. Oracle Object Storage speaks S3. To use it:

1. Create a bucket.
2. Create a key pair under your user profile → Customer Secret Keys.
3. Set these variables:

```sh
STORAGE_DRIVER=s3
S3_BUCKET=<bucket>
S3_REGION=<region, e.g. me-jeddah-1>
S3_ENDPOINT=https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
S3_FORCE_PATH_STYLE=true
```

### 5. First release, from the Mac

```sh
deploy/release.sh ubuntu@<server-ip>
```

The script refuses to run while anything under `src/` is uncommitted. Once it
finishes, look at the logs on the server:

```sh
pm2 logs clinic-api
```

You should see `Connected to MongoDB` and `Listening to port 3000`. If you see a
`Config validation error`, it names the variable that is missing.

### 6. Start on boot, rotate logs

On the server, run this. It prints a `sudo ...` command; run that too:

```sh
pm2 startup systemd
```

Then add log rotation, so the logs don't fill the disk:

```sh
pm2 install pm2-logrotate
```

### 7. nginx and HTTPS

Copy the site config from the Mac:

```sh
scp deploy/nginx/clinic-api.conf ubuntu@<server-ip>:/tmp/
```

Then, on the server, set your domain name in the config and enable it:

```sh
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo mv /tmp/clinic-api.conf /etc/nginx/sites-available/clinic-api
sudo sed -i 's/api.example.com/api.yourclinic.pk/' /etc/nginx/sites-available/clinic-api
sudo ln -s /etc/nginx/sites-available/clinic-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Get a certificate. Certbot adds the 443 block and the HTTP-to-HTTPS redirect
itself, and renews the certificate on a timer:

```sh
sudo certbot --nginx -d api.yourclinic.pk
```

### 8. Check it from outside

```sh
curl -i https://api.yourclinic.pk/api/v1/me
```

A `401` with a JSON body means the whole path works: DNS, TLS, nginx and the
API. Point the app's API URL at `https://api.yourclinic.pk/api/v1`.

## Releasing a new version

Commit, then run the script again from the Mac:

```sh
deploy/release.sh ubuntu@<server-ip>
```

To roll back, check out the earlier commit and run it again. The commit that is
live is in `/srv/clinic-api/REVISION`.

## Backups

The database holds prescriptions and patient records. Dump it every night and
keep 14 days. Run `crontab -e` on the server and add one line:

```sh
30 2 * * * mongodump --uri='mongodb://clinic:<password>@127.0.0.1:27017/clinic-api?authSource=admin' --gzip --archive=/var/backups/clinic-api/$(date +\%F).gz && find /var/backups/clinic-api -name '*.gz' -mtime +14 -delete
```

The backup folder has to exist first:

```sh
sudo mkdir -p /var/backups/clinic-api && sudo chown "$USER" /var/backups/clinic-api
```

A backup on the same disk doesn't survive losing the VM, so copy these dumps to
an Object Storage bucket. Do the same for `/srv/clinic-api/.storage` while it
is in use.

## Oracle Linux instead of Ubuntu

- The user is `opc`. Use `dnf` in place of `apt-get`, NodeSource's
  `rpm.nodesource.com/setup_22.x`, and MongoDB's RHEL repo.
- Open the ports with `firewalld`, not iptables:

  ```sh
  sudo firewall-cmd --permanent --add-service=http --add-service=https
  sudo firewall-cmd --reload
  ```

- SELinux blocks nginx from connecting to port 3000 until you allow it:

  ```sh
  sudo setsebool -P httpd_can_network_connect 1
  ```

  Without this, every request returns a 502.

- Put the nginx config in `/etc/nginx/conf.d/clinic-api.conf`. That
  distribution has no `sites-available` directory.
