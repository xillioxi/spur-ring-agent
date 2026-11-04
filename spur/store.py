import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, channel_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
 last_success REAL, last_error TEXT
);
CREATE TABLE IF NOT EXISTS items (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
 title TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL,
 published REAL NOT NULL, collected REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS items_published ON items(published);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 available REAL NOT NULL, lease_until REAL, token TEXT, result TEXT, error TEXT,
 created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
 id TEXT PRIMARY KEY, job_id TEXT UNIQUE NOT NULL, content TEXT NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
 interval_seconds INTEGER NOT NULL, next_run REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
 kind TEXT NOT NULL, created REAL NOT NULL, report_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS missions (
 id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
 state TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id),
 message TEXT NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist_actions (
 id TEXT PRIMARY KEY, source_ids TEXT NOT NULL, created REAL NOT NULL, restored INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS execution_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
 mission_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL, created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_events_job ON execution_events(job_id,id);
CREATE INDEX IF NOT EXISTS execution_events_mission ON execution_events(mission_id,id);
CREATE TABLE IF NOT EXISTS agents (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
 instructions TEXT NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id),
 request_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES jobs(id), metadata TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL,
 UNIQUE(request_id,role)
);
CREATE INDEX IF NOT EXISTS chat_agent ON chat_messages(agent_id,id);
CREATE TABLE IF NOT EXISTS mission_requests (request_key TEXT PRIMARY KEY,mission_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')), created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS user_sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(user_id);
CREATE TABLE IF NOT EXISTS login_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, client_hash TEXT NOT NULL, created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_time ON login_attempts(created);
CREATE TABLE IF NOT EXISTS user_workspaces (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 legacy INTEGER NOT NULL DEFAULT 0, onboarding_complete INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS social_apps (
 platform TEXT PRIMARY KEY,client_id TEXT NOT NULL,secret BLOB NOT NULL,
 redirect_uri TEXT NOT NULL,api_version TEXT NOT NULL,updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS social_connections (
 platform TEXT PRIMARY KEY,tokens BLOB NOT NULL,account_id TEXT NOT NULL,account_name TEXT NOT NULL,
 candidates TEXT NOT NULL,status TEXT NOT NULL,expires REAL NOT NULL,last_sync REAL,last_error TEXT,
 generation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS social_snapshots (
 id TEXT PRIMARY KEY,platform TEXT NOT NULL,account_id TEXT NOT NULL,days INTEGER NOT NULL,
 content TEXT NOT NULL,created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS social_snapshots_recent ON social_snapshots(platform,created);
CREATE TABLE IF NOT EXISTS social_oauth_tickets (
 ticket_hash TEXT PRIMARY KEY,state_hash TEXT NOT NULL,user_id TEXT NOT NULL,
 session_hash TEXT NOT NULL,platform TEXT NOT NULL,payload BLOB NOT NULL,expires REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS social_oauth_returns (
 nonce_hash TEXT PRIMARY KEY,ticket_hash TEXT NOT NULL,payload BLOB NOT NULL,expires REAL NOT NULL
);
"""


class Store:
    def __init__(self, path):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            from spur.library import SCHEMA as LIBRARY_SCHEMA
            db.executescript(LIBRARY_SCHEMA)
            from spur.office import SCHEMA as OFFICE_SCHEMA
            db.executescript(OFFICE_SCHEMA)
            db.execute("INSERT OR IGNORE INTO user_workspaces(user_id,legacy) SELECT id,CASE WHEN role='owner' THEN 1 ELSE 0 END FROM users")
            db.execute("INSERT OR IGNORE INTO agents VALUES(?,?,?,?,?)", ("youtube-research", "YouTube Research",
                       "Discover channels, build a watchlist, and turn video evidence into research.",
                       "You specialize in YouTube channel research and evidence-based industry analysis.",time.time()))
            for agent_id,name,description,instructions in [
                ("coordinator","Team Coordinator","Break goals into assignments, coordinate handoffs, and synthesize the team's research.","Coordinate bounded research assignments using the available specialists."),
                ("channel-scout","Channel Scout","Find and screen relevant YouTube channels, then build an evidence-backed watchlist.","Focus on discovering and screening channels. Prioritize relevance and coverage. Explain exclusions and coverage gaps."),
                ("research-analyst","Research Analyst","Compare collected evidence and turn specialist findings into practical conclusions.","Focus on analysis of the existing watchlist and saved research. Do not discover additional channels unless explicitly requested. Distinguish evidence from inference.")]:
                db.execute("INSERT OR IGNORE INTO agents VALUES(?,?,?,?,?)",(agent_id,name,description,instructions,time.time()))
            from spur.lead import MARKETING_LEAD
            db.execute("UPDATE agents SET name=?,description=?,instructions=? WHERE id='coordinator' AND name IN ('Team Coordinator','Marketing Lead')",
                       (MARKETING_LEAD['name'],MARKETING_LEAD['description'],MARKETING_LEAD['instructions']))
            from spur.creator_catalog import CREATOR_AGENTS
            for profile in CREATOR_AGENTS:
                db.execute("INSERT OR IGNORE INTO agents VALUES(?,?,?,?,?)",(profile['id'],profile['name'],profile['description'],profile['instructions'],time.time()))
            db.execute("UPDATE agents SET name='Competitor Analyst' WHERE id='research-analyst' AND name='Research Analyst'")
            columns = {r[1] for r in db.execute("PRAGMA table_info(sources)")}
            if "archived" not in columns:
                db.execute("ALTER TABLE sources ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
            # Upgrade existing installations without losing earlier research.
            for row in db.execute("SELECT * FROM reports WHERE id NOT IN (SELECT report_id FROM knowledge WHERE report_id IS NOT NULL)").fetchall():
                report = json.loads(row["content"])
                memory = json.dumps({"summary": report.get("summary", ""), "sources": report.get("sources", {}),
                                     "limitations": report.get("limitations", [])})
                db.execute("INSERT INTO knowledge VALUES(?,?,?,?,?,?)", (uuid.uuid4().hex,
                           report.get("topic", "Research report")[:300], memory, "report", row["created"], row["id"]))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def sources(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute("SELECT * FROM sources WHERE archived=0 ORDER BY name")]

    def agents(self):
        with self.connect() as db:
            from spur.creator_catalog import creator_profile
            from spur.lead import MARKETING_LEAD
            return [{**dict(r),"workflow":(creator_profile(r['id']) or {}).get('kind','coordinator' if r['id']=='coordinator' else 'research'),
                     "example":MARKETING_LEAD['example'] if r['id']=='coordinator' else (creator_profile(r['id']) or {}).get('example',''),
                     "is_orchestrator":r['id']=='coordinator',"creator_specialist":creator_profile(r['id']) is not None}
                    for r in db.execute("SELECT * FROM agents ORDER BY CASE WHEN id='coordinator' THEN 0 ELSE 1 END,created")]

    def agent(self, agent_id):
        with self.connect() as db:
            row=db.execute("SELECT * FROM agents WHERE id=?",(agent_id,)).fetchone()
            return dict(row) if row else None

    def add_agent(self,name,description,instructions):
        agent_id=uuid.uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO agents VALUES(?,?,?,?,?)",(agent_id,name,description,instructions,time.time()))
        return self.agent(agent_id)

    def enqueue_chat(self,agent_id,content,request_id):
        if not self.agent(agent_id):raise ValueError('Agent not found')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous=db.execute("SELECT * FROM chat_messages WHERE request_id=? AND role='user'",(request_id,)).fetchone()
            if previous:
                if previous['agent_id']!=agent_id or previous['content']!=content:raise ValueError('Message request ID already used')
                return previous['job_id']
            pending=db.execute("SELECT 1 FROM jobs WHERE kind='chat' AND status IN ('queued','running') AND json_extract(payload,'$.agent_id')=?",(agent_id,)).fetchone()
            if pending:raise ValueError('This agent is still replying. Wait for its response before sending another message.')
            job_id=self._enqueue(db,'chat',{'agent_id':agent_id,'request_id':request_id},time.time())
            db.execute('INSERT INTO chat_messages(agent_id,request_id,role,content,job_id,created) VALUES(?,?,?,?,?,?)',
                       (agent_id,request_id,'user',content,job_id,time.time()))
            return job_id

    def chat(self,agent_id,limit=100,before_request=None,before_id=None):
        with self.connect() as db:
            bound=before_id or 9223372036854775807
            if before_request:
                current=db.execute("SELECT id FROM chat_messages WHERE agent_id=? AND request_id=? AND role='user'",(agent_id,before_request)).fetchone()
                if not current:raise ValueError('Chat message not found')
                bound=current[0]+1
            rows=db.execute('SELECT c.*,j.status,j.error FROM chat_messages c JOIN jobs j ON j.id=c.job_id '
                            'WHERE c.agent_id=? AND c.id<? ORDER BY c.id DESC LIMIT ?',(agent_id,bound,limit)).fetchall()
            return [{**dict(r),'metadata':json.loads(r['metadata'])} for r in reversed(rows)]

    def requested_mission(self,request_key):
        with self.connect() as db:
            row=db.execute('SELECT mission_id FROM mission_requests WHERE request_key=?',(request_key,)).fetchone()
            return row[0] if row else None

    def finish_chat(self,job,content,metadata):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            owner=db.execute('SELECT token,status FROM jobs WHERE id=?',(job['id'],)).fetchone()
            if not owner or owner['token']!=job['token'] or owner['status']!='running':raise RuntimeError('Job lease ownership lost')
            db.execute("INSERT OR IGNORE INTO chat_messages(agent_id,request_id,role,content,job_id,metadata,created) VALUES(?,?,?,?,?,?,?)",
                       (job['payload']['agent_id'],job['payload']['request_id'],'assistant',content,job['id'],json.dumps(metadata),time.time()))
            db.execute("UPDATE jobs SET status='succeeded',result=?,error=NULL,lease_until=NULL WHERE id=?",(json.dumps(metadata),job['id']))

    def retry_chat(self,agent_id,job_id):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
            if not row or row['kind']!='chat' or json.loads(row['payload'])['agent_id']!=agent_id:raise ValueError('Chat job not found')
            if row['status']!='failed':raise ValueError('Only a failed reply can be retried')
            pending=db.execute("SELECT 1 FROM jobs WHERE kind='chat' AND status IN ('queued','running') AND json_extract(payload,'$.agent_id')=?",(agent_id,)).fetchone()
            if pending:raise ValueError('This agent is already replying')
            db.execute("UPDATE jobs SET status='queued',attempts=0,error=NULL,available=?,token=NULL,lease_until=NULL WHERE id=?",(time.time(),job_id))

    def record_event(self, job, kind, title, details=None):
        # Callers supply explicit operational summaries, never raw model messages,
        # credentials, reasoning_content, or encrypted provider reasoning items.
        with self.connect() as db:
            db.execute("INSERT INTO execution_events(job_id,mission_id,kind,title,details,created) VALUES(?,?,?,?,?,?)",
                       (job["id"],job["payload"].get("mission_id"),kind,title[:1000],json.dumps(details or {}),time.time()))

    def job_events(self, job_id, limit=100):
        with self.connect() as db:
            return [{**dict(r),"details":json.loads(r["details"])} for r in db.execute(
                "SELECT kind,title,details,created FROM execution_events WHERE job_id=? ORDER BY id DESC LIMIT ?",(job_id,limit))]

    @staticmethod
    def mission_events(db, mission_id, limit=100):
        rows=db.execute("SELECT message AS title,'checkpoint' AS kind,'{}' AS details,created FROM mission_events WHERE mission_id=? "
                        "UNION ALL SELECT title,kind,details,created FROM execution_events WHERE mission_id=? "
                        "ORDER BY created DESC LIMIT ?",(mission_id,mission_id,limit)).fetchall()
        return [{**dict(r),"message":r["title"],"details":json.loads(r["details"])} for r in rows]

    def clear_watchlist(self, action_id):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT source_ids FROM watchlist_actions WHERE id=?", (action_id,)).fetchone()
            if previous:
                return len(json.loads(previous[0]))
            ids = [r[0] for r in db.execute("SELECT id FROM sources WHERE archived=0")]
            db.execute("UPDATE sources SET archived=1 WHERE archived=0")
            db.execute("INSERT INTO watchlist_actions(id,source_ids,created) VALUES(?,?,?)", (action_id,json.dumps(ids),time.time()))
            # Clearing the watchlist supersedes missions that could add channels back.
            for row in db.execute("SELECT id FROM missions WHERE status IN ('active','paused','failed') AND id!=?", (action_id,)).fetchall():
                db.execute("UPDATE missions SET status='cancelled',updated=? WHERE id=?", (time.time(),row[0]))
                db.execute("INSERT INTO mission_events(mission_id,message,created) VALUES(?,?,?)", (row[0],"Stopped because the user cleared the watchlist.",time.time()))
            return len(ids)

    def restore_watchlist(self, action_id):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM watchlist_actions WHERE id=?", (action_id,)).fetchone()
            if not row:
                raise ValueError("Watchlist action not found")
            ids=json.loads(row["source_ids"])
            if row["restored"]:
                return 0
            db.executemany("UPDATE sources SET archived=0 WHERE id=?", [(i,) for i in ids])
            db.execute("UPDATE watchlist_actions SET restored=1 WHERE id=?", (action_id,))
            return len(ids)

    def create_mission(self, prompt, days, agent_id="youtube-research",input_report=None,request_key=None):
        agent=self.agent(agent_id)
        if not agent:
            raise ValueError("Agent not found")
        mission_id = uuid.uuid4().hex
        now = time.time()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if request_key:
                previous=db.execute('SELECT mission_id FROM mission_requests WHERE request_key=?',(request_key,)).fetchone()
                if previous:return previous[0]
            db.execute("INSERT INTO missions VALUES(?,?,?,?,?,?)", (mission_id, prompt, "active",
                       json.dumps({"phase": "plan", "days": days, "queries_done": 0, "candidates": [],
                                   "channels": [], "checked": [], "failures": [], "model_calls": 0,
                                   "agent_id":agent_id,"agent_name":agent["name"],"agent_instructions":agent["instructions"],
                                   "input_report":input_report,
                                   **({"phase":"team_plan","children":[]} if agent_id=="coordinator" else {})}), now, now))
            self._enqueue(db, "mission", {"mission_id": mission_id}, now)
            db.execute("INSERT INTO mission_events(mission_id,message,created) VALUES(?,?,?)",
                       (mission_id, "Mission accepted. Planning the research.", now))
            if request_key:db.execute('INSERT INTO mission_requests VALUES(?,?)',(request_key,mission_id))
        return mission_id

    def missions(self):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM missions ORDER BY created DESC LIMIT 50").fetchall()
            output = []
            for row in rows:
                events = self.mission_events(db,row["id"],12)
                output.append({**dict(row), "state": json.loads(row["state"]), "events": events})
            return output

    def mission(self, mission_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not row:
                return None
            events = self.mission_events(db,mission_id)
            return {**dict(row), "state": json.loads(row["state"]), "events": events}

    def control_mission(self, mission_id, action):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not row:
                raise ValueError("Mission not found")
            status = row[0]
            if action == "resume" and status in ("paused", "failed"):
                status = "active"
                self._enqueue(db, "mission", {"mission_id": mission_id}, time.time())
            elif action == "pause" and status == "active":
                status = "paused"
            elif action == "cancel" and status in ("active", "paused", "failed"):
                status = "cancelled"
            else:
                raise ValueError("Action is not valid for the current mission status")
            db.execute("UPDATE missions SET status=?,updated=? WHERE id=?", (status, time.time(), mission_id))
            db.execute("INSERT INTO mission_events(mission_id,message,created) VALUES(?,?,?)",
                       (mission_id, f"Mission {status}. In-flight requests finish at the next checkpoint.", time.time()))
            state=json.loads(db.execute("SELECT state FROM missions WHERE id=?",(mission_id,)).fetchone()[0])
            for child_id in state.get("children",[]):
                child=db.execute("SELECT status FROM missions WHERE id=?",(child_id,)).fetchone()
                if child and action in ("pause","cancel") and child[0] in ("active","paused"):
                    db.execute("UPDATE missions SET status=?,updated=? WHERE id=?",("paused" if action=="pause" else "cancelled",time.time(),child_id))
                elif child and action=="resume" and child[0]=="paused":
                    db.execute("UPDATE missions SET status='active',updated=? WHERE id=?",(time.time(),child_id))
                    self._enqueue(db,"mission",{"mission_id":child_id},time.time())

    def checkpoint_mission(self, job, state, message, terminal=None, report=None, delay=0):
        """Save progress, finish this step and queue its successor atomically."""
        now = time.time()
        mission_id = job["payload"]["mission_id"]
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            owner = db.execute("SELECT token,status FROM jobs WHERE id=?", (job["id"],)).fetchone()
            if owner["token"] != job["token"] or owner["status"] != "running":
                raise RuntimeError("Job lease ownership lost")
            current = db.execute("SELECT status FROM missions WHERE id=?", (mission_id,)).fetchone()[0]
            status = terminal if current == "active" and terminal else current
            result = {"mission_id": mission_id, "phase": state["phase"]}
            if report is not None and current != "cancelled":
                report_id = uuid.uuid4().hex
                state["report_id"] = result["report_id"] = report_id
                db.execute("INSERT INTO reports VALUES(?,?,?,?)", (report_id, job["id"], json.dumps(report), now))
                memory = json.dumps({"summary": report["summary"], "artifact":report.get('artifact'),"sources": report["sources"], "limitations": report["limitations"]})
                db.execute("INSERT INTO knowledge VALUES(?,?,?,?,?,?)", (uuid.uuid4().hex, report["topic"][:300], memory, "report", now, report_id))
            db.execute("UPDATE missions SET state=?,status=?,updated=? WHERE id=?", (json.dumps(state), status, now, mission_id))
            db.execute("INSERT INTO mission_events(mission_id,message,created) VALUES(?,?,?)", (mission_id, message[:2000], now))
            db.execute("UPDATE jobs SET status='succeeded',result=?,error=NULL,lease_until=NULL WHERE id=?", (json.dumps(result), job["id"]))
            if status == "active":
                # A resume may already have queued the successor while this step was in flight.
                pending = db.execute("SELECT 1 FROM jobs WHERE kind='mission' AND status='queued' AND json_extract(payload,'$.mission_id')=?", (mission_id,)).fetchone()
                if not pending:
                    self._enqueue(db, "mission", {"mission_id": mission_id}, now+delay)

    def delegate_mission(self,parent_id,task_index,agent_id,prompt,days):
        """Create a child and link it atomically; retrying a handoff cannot duplicate it."""
        agent=self.agent(agent_id)
        if not agent or agent_id=="coordinator":
            raise ValueError("Choose a registered specialist")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            parent=db.execute("SELECT * FROM missions WHERE id=?",(parent_id,)).fetchone()
            state=json.loads(parent["state"])
            children=state.setdefault("children",[])
            if task_index<len(children):
                return children[task_index]
            if parent["status"]!="active":
                return None
            child_id=uuid.uuid4().hex;now=time.time()
            child_state={"phase":"plan","days":days,"queries_done":0,"candidates":[],"channels":[],"checked":[],
                         "failures":[],"model_calls":0,"agent_id":agent_id,"agent_name":agent["name"],
                         "agent_instructions":agent["instructions"],"parent_mission_id":parent_id}
            db.execute("INSERT INTO missions VALUES(?,?,?,?,?,?)",(child_id,prompt,"active",json.dumps(child_state),now,now))
            self._enqueue(db,"mission",{"mission_id":child_id},now)
            children.append(child_id)
            db.execute("UPDATE missions SET state=?,updated=? WHERE id=?",(json.dumps(state),now,parent_id))
            db.execute("INSERT INTO mission_events(mission_id,message,created) VALUES(?,?,?)",(child_id,"Assignment received from Marketing Lead.",now))
            return child_id

    def mission_evidence(self, channel_ids):
        with self.connect() as db:
            output = []
            for channel_id in channel_ids:
                rows = db.execute("SELECT items.*,sources.name AS source_name FROM items JOIN sources ON sources.id=source_id "
                                  "WHERE sources.channel_id=? ORDER BY published DESC LIMIT 3", (channel_id,)).fetchall()
                output.extend(dict(r) for r in rows)
            return output

    def get_runtime(self, key, default=None):
        with self.connect() as db:
            row = db.execute("SELECT value FROM runtime WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def add_knowledge(self, title, content):
        item_id = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO knowledge VALUES(?,?,?,?,?,NULL)", (item_id, title, content, "note", time.time()))
        return item_id

    def knowledge(self, query="", limit=30):
        with self.connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM knowledge WHERE (?='' OR instr(lower(title || ' ' || content),lower(?))>0) "
                "ORDER BY created DESC LIMIT ?", (query, query, limit))]

    def knowledge_count(self):
        with self.connect() as db:
            return db.execute("SELECT count(*) FROM knowledge").fetchone()[0]

    def set_runtime(self, key, value):
        with self.connect() as db:
            db.execute("INSERT INTO runtime VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, json.dumps(value)))

    def dashboard(self):
        with self.connect() as db:
            counts = {"sources": db.execute("SELECT count(*) FROM sources WHERE archived=0").fetchone()[0],
                      "videos": db.execute("SELECT count(*) FROM items").fetchone()[0],
                      "reports": db.execute("SELECT count(*) FROM reports").fetchone()[0],
                      "active_jobs": db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]}
            jobs = [dict(r) for r in db.execute("SELECT id,kind,status,attempts,created,error,result,payload FROM jobs ORDER BY created DESC LIMIT 50")]
            for job in jobs:
                for key in ("payload", "result"):
                    job[key] = json.loads(job[key]) if job[key] else None
                events=db.execute("SELECT kind,title,details,created FROM execution_events WHERE job_id=? ORDER BY id DESC LIMIT 6",(job["id"],)).fetchall()
                job["events"]=[{**dict(e),"details":json.loads(e["details"])} for e in events]
        heartbeat = self.get_runtime("worker_heartbeat", 0)
        return {"counts": counts, "jobs": jobs, "worker_online": time.time() - heartbeat < 20,
                "worker_heartbeat": heartbeat}

    def add_source(self, channel_id, name, mission_id=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if mission_id:
                row=db.execute("SELECT status FROM missions WHERE id=?",(mission_id,)).fetchone()
                if not row or row[0] != "active":
                    return None
            db.execute("INSERT INTO sources(id,channel_id,name) VALUES(?,?,?) "
                       "ON CONFLICT(channel_id) DO UPDATE SET name=excluded.name,archived=0",
                       (uuid.uuid4().hex, channel_id, name))
            return dict(db.execute("SELECT * FROM sources WHERE channel_id=?", (channel_id,)).fetchone())

    def save_items(self, source_id, items):
        with self.connect() as db:
            for item in items:
                db.execute("INSERT INTO items VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                           "title=excluded.title,description=excluded.description",
                           (item["id"], source_id, item["title"], item["description"],
                            item["url"], item["published"], time.time()))
            db.execute("UPDATE sources SET last_success=?,last_error=NULL WHERE id=?",
                       (time.time(), source_id))

    def source_error(self, source_id, error):
        with self.connect() as db:
            db.execute("UPDATE sources SET last_error=? WHERE id=?", (error[:1000], source_id))

    def items(self, since, until, query="", limit=60):
        with self.connect() as db:
            # instr treats user text literally, without SQL LIKE wildcard expansion.
            return [dict(r) for r in db.execute(
                "SELECT items.*,sources.name AS source_name FROM items JOIN sources ON sources.id=source_id "
                "WHERE published>=? AND published<? AND "
                "(?='' OR instr(lower(title || ' ' || description), lower(?))>0) "
                "ORDER BY published DESC LIMIT ?", (since, until, query, query, limit))]

    @staticmethod
    def _enqueue(db, kind, payload, now):
        job_id = uuid.uuid4().hex
        db.execute("INSERT INTO jobs(id,kind,payload,available,created) VALUES(?,?,?,?,?)",
                   (job_id, kind, json.dumps(payload), now, now))
        return job_id

    def enqueue(self, kind, payload):
        with self.connect() as db:
            return self._enqueue(db, kind, payload, time.time())

    def job(self, job_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            result = dict(row)
            for key in ("payload", "result"):
                if result[key] is not None:
                    result[key] = json.loads(result[key])
            result.pop("token")
            return result

    def claim(self):
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            expired = db.execute("SELECT id,payload FROM jobs WHERE kind='mission' AND status='running' AND lease_until<? AND attempts>=3", (now,)).fetchall()
            db.execute("UPDATE jobs SET status='failed',error='Worker lease expired after final attempt' "
                       "WHERE status='running' AND lease_until<? AND attempts>=3", (now,))
            for lost in expired:
                mission_id = json.loads(lost["payload"])["mission_id"]
                other = db.execute("SELECT 1 FROM jobs WHERE kind='mission' AND status IN ('queued','running') AND json_extract(payload,'$.mission_id')=?", (mission_id,)).fetchone()
                if not other:
                    db.execute("UPDATE missions SET status='failed',updated=? WHERE id=? AND status='active'", (now, mission_id))
                    db.execute("INSERT INTO mission_events(mission_id,message,created) VALUES(?,?,?)",
                               (mission_id, "Worker lease expired after the final attempt. Resume to retry from the last checkpoint.", now))
            row = db.execute("SELECT * FROM jobs WHERE attempts<3 AND "
                             "((status='queued' AND available<=?) OR (status='running' AND lease_until<?)) "
                             "ORDER BY CASE WHEN kind='chat' THEN 0 ELSE 1 END,created LIMIT 1", (now, now)).fetchone()
            if not row:
                return None
            job = dict(row)
            job["token"] = uuid.uuid4().hex
            db.execute("UPDATE jobs SET status='running',attempts=attempts+1,lease_until=?,token=? WHERE id=?",
                       (now + 900, job["token"], job["id"]))
            job["payload"] = json.loads(job["payload"])
            return job

    def finish(self, job, result, report=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT token,status FROM jobs WHERE id=?", (job["id"],)).fetchone()
            if row["token"] != job["token"] or row["status"] != "running":
                raise RuntimeError("Job lease ownership lost")
            if report is not None:
                db.execute("INSERT INTO reports VALUES(?,?,?,?)",
                           (result["report_id"], job["id"], json.dumps(report), time.time()))
                # Store provenance with the summary; recalled analysis is not fresh evidence.
                memory = json.dumps({"summary": report.get("summary", ""),
                                     "sources": report.get("sources", {}),
                                     "limitations": report.get("limitations", [])})
                db.execute("INSERT INTO knowledge VALUES(?,?,?,?,?,?)", (uuid.uuid4().hex,
                           report.get("topic", "Research report")[:300], memory, "report", time.time(), result["report_id"]))
            db.execute("UPDATE jobs SET status='succeeded',result=?,error=NULL,lease_until=NULL WHERE id=?",
                       (json.dumps(result), job["id"]))

    def fail(self, job, error):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END, "
                       "error=?,available=?,lease_until=NULL WHERE id=? AND token=? AND status='running'",
                       (error[:1000], time.time() + 30, job["id"], job["token"]))
            if job["kind"] == "mission":
                row = db.execute("SELECT status FROM jobs WHERE id=?", (job["id"],)).fetchone()
                mission_id = job["payload"]["mission_id"]
                if row[0] == "failed":
                    db.execute("UPDATE missions SET status='failed',updated=? WHERE id=? AND status='active'", (time.time(), mission_id))
                db.execute("INSERT INTO mission_events(mission_id,message,created) VALUES(?,?,?)",
                           (mission_id, error[:1000], time.time()))

    def reports(self, report_id=None):
        with self.connect() as db:
            db.execute("DELETE FROM reports WHERE json_extract(content,'$.artifact.kind')='metadata_analysis' AND json_extract(content,'$.expires_at')<?",(time.time(),))
            if report_id:
                row = db.execute("SELECT * FROM reports WHERE id=?", (report_id,)).fetchone()
                return {**dict(row), "content": json.loads(row["content"])} if row else None
            return [dict(r) for r in db.execute("SELECT id,job_id,created,json_extract(content,'$.title') AS title, "
                "json_extract(content,'$.topic') AS topic,json_extract(content,'$.artifact.kind') AS artifact_kind,"
                "json_extract(content,'$.agent_id') AS agent_id FROM reports ORDER BY created DESC LIMIT 100")]

    def add_schedule(self, kind, payload, interval):
        schedule_id = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO schedules VALUES(?,?,?,?,?)",
                       (schedule_id, kind, json.dumps(payload), interval, time.time()))
        return schedule_id

    def schedules(self):
        with self.connect() as db:
            return [{**dict(r), "payload": json.loads(r["payload"])} for r in db.execute("SELECT * FROM schedules")]

    def delete_schedule(self, schedule_id):
        with self.connect() as db:
            return db.execute("DELETE FROM schedules WHERE id=?", (schedule_id,)).rowcount > 0

    def tick(self):
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM reports WHERE json_extract(content,'$.artifact.kind')='metadata_analysis' AND json_extract(content,'$.expires_at')<?",(now,))
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discovery_runs'").fetchone():
                db.execute('DELETE FROM discovery_runs WHERE expires<?',(now,))
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discovery_tool_calls'").fetchone():
                db.execute('DELETE FROM discovery_tool_calls WHERE created<?',(now-29*86400,))
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_media'").fetchone():
                from spur.mock_profiles import expire_public_metadata
                expire_public_metadata(self,db,now)
            for row in db.execute("SELECT * FROM schedules WHERE next_run<=?", (now,)).fetchall():
                self._enqueue(db, row["kind"], json.loads(row["payload"]), now)
                db.execute("UPDATE schedules SET next_run=? WHERE id=?", (now + row["interval_seconds"], row["id"]))
