"""SQLite accounts, revocable cookie sessions and private workspace routing."""
import hashlib
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from dataclasses import replace

COOKIE='spur_account'
ITERATIONS=600_000


class AuthError(ValueError):
    def __init__(self,message,status=400):super().__init__(message);self.status=status


def hash_password(password):
    if not 12<=len(password)<=128:raise AuthError('Use a password with 12–128 characters.',422)
    salt=secrets.token_hex(16)
    digest=hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),ITERATIONS).hex()
    return f'pbkdf2_sha256${ITERATIONS}${salt}${digest}'


DUMMY_HASH=hash_password('dummy-password-for-timing')


def verify_password(password,encoded):
    try:
        algorithm,iterations,salt,digest=encoded.split('$')
        if algorithm!='pbkdf2_sha256' or int(iterations)!=ITERATIONS:return False
        actual=hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),int(iterations)).hex()
        return secrets.compare_digest(actual,digest)
    except (ValueError,TypeError):return False


def public_user(row):
    return {key:row[key] for key in ('id','username','display_name','role','created')}


def token_hash(token):return hashlib.sha256(token.encode()).hexdigest()


class Accounts:
    def __init__(self,store):self.store=store

    def has_users(self):
        with self.store.connect() as db:return bool(db.execute('SELECT 1 FROM users LIMIT 1').fetchone())

    def create_user(self,username,display_name,password,allow_existing=False):
        username=username.strip().lower();display_name=display_name.strip()
        if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{2,39}',username):
            raise AuthError('Use a username with 3–40 letters, numbers, dots, hyphens or underscores.',422)
        if not 1<=len(display_name)<=80:raise AuthError('Enter a display name (1–80 characters).',422)
        encoded=hash_password(password)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            existing=db.execute('SELECT 1 FROM users LIMIT 1').fetchone()
            if existing and not allow_existing:raise AuthError('An owner account already exists. Ask the owner to add your account.',403)
            user={'id':uuid.uuid4().hex,'username':username,'display_name':display_name,
                  'role':'member' if existing else 'owner','created':time.time()}
            try:db.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',(user['id'],username,display_name,encoded,user['role'],user['created']))
            except sqlite3.IntegrityError:raise AuthError('That username is already in use.',409) from None
            db.execute('INSERT INTO user_workspaces(user_id,legacy) VALUES(?,?)',(user['id'],0 if existing else 1))
            return user

    def workspace_path(self,user_id):
        with self.store.connect() as db:
            row=db.execute('SELECT legacy FROM user_workspaces WHERE user_id=?',(user_id,)).fetchone()
        if not row:raise AuthError('Account workspace not found.',404)
        return str(Path(self.store.path).resolve()) if row['legacy'] else str(Path(self.store.path).resolve().parent/'workspaces'/user_id/'workspace.db')

    def workspace_paths(self):
        return [self.workspace_path(user['id']) for user in self.users()]

    def onboarding(self,user_id):
        with self.store.connect() as db:
            row=db.execute('SELECT onboarding_complete FROM user_workspaces WHERE user_id=?',(user_id,)).fetchone()
            return {'completed':bool(row['onboarding_complete'])}

    def complete_onboarding(self,user_id):
        with self.store.connect() as db:db.execute('UPDATE user_workspaces SET onboarding_complete=1 WHERE user_id=?',(user_id,))

    def reserve_signup(self,client):
        now=time.time();client_hash=token_hash(client)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            count=db.execute("SELECT COUNT(*) FROM login_attempts WHERE username='!signup' AND client_hash=? AND created>?",(client_hash,now-900)).fetchone()[0]
            if count>=10:raise AuthError('Too many signup attempts. Try again in 15 minutes.',429)
            db.execute("INSERT INTO login_attempts(username,client_hash,created) VALUES('!signup',?,?)",(client_hash,now))

    def login(self,username,password,client):
        username=username.strip().lower();client_hash=token_hash(client);now=time.time()
        # Reserve the attempt before hashing, so concurrent failures share a limit.
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM login_attempts WHERE created<?',(now-900,))
            count=db.execute('SELECT COUNT(*) FROM login_attempts WHERE username=?',(username,)).fetchone()[0]
            network=db.execute('SELECT COUNT(*) FROM login_attempts WHERE client_hash=?',(client_hash,)).fetchone()[0]
            if count>=8 or network>=30:raise AuthError('Too many login attempts. Try again in 15 minutes.',429)
            cursor=db.execute('INSERT INTO login_attempts(username,client_hash,created) VALUES(?,?,?)',(username,client_hash,now))
            attempt_id=cursor.lastrowid
            user=db.execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
        valid=verify_password(password,user['password_hash'] if user else DUMMY_HASH)
        if not valid or not user:raise AuthError('Incorrect username or password.',401)
        with self.store.connect() as db:
            db.execute('DELETE FROM login_attempts WHERE id=?',(attempt_id,))
        return public_user(user)

    def create_session(self,user_id,remember=False):
        token=secrets.token_urlsafe(32);csrf=secrets.token_urlsafe(32);now=time.time()
        expires=now+(30*86400 if remember else 8*3600)
        with self.store.connect() as db:
            db.execute('DELETE FROM user_sessions WHERE expires<=?',(now,))
            db.execute('INSERT INTO user_sessions VALUES(?,?,?,?,?)',(token_hash(token),user_id,csrf,now,expires))
        return {'token':token,'csrf':csrf,'expires':expires}

    def session(self,token):
        if not token or len(token)>200:return None
        with self.store.connect() as db:
            row=db.execute('SELECT u.*,s.csrf,s.expires FROM user_sessions s JOIN users u ON u.id=s.user_id '
                           'WHERE s.token_hash=? AND s.expires>?',(token_hash(token),time.time())).fetchone()
            return {'user':public_user(row),'csrf':row['csrf'],'expires':row['expires']} if row else None

    def logout(self,token):
        if token:
            with self.store.connect() as db:db.execute('DELETE FROM user_sessions WHERE token_hash=?',(token_hash(token),))

    def change_password(self,user_id,current_password,new_password):
        with self.store.connect() as db:row=db.execute('SELECT password_hash FROM users WHERE id=?',(user_id,)).fetchone()
        if not row or not verify_password(current_password,row[0]):raise AuthError('The current password is incorrect.',400)
        encoded=hash_password(new_password)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            updated=db.execute('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?',(encoded,user_id,row[0]))
            if not updated.rowcount:raise AuthError('Password changed in another session. Sign in again.',409)
            db.execute('DELETE FROM user_sessions WHERE user_id=?',(user_id,))

    def users(self):
        with self.store.connect() as db:return [public_user(row) for row in db.execute('SELECT * FROM users ORDER BY created')]


def workspace_settings(config,path):
    if Path(config.db_path).resolve()==Path(path).resolve():return config
    return replace(config,db_path=str(path),model='',provider='ollama',allow_env_keys=False)
