"""
app.db — SQLite database for user management, project index, access control,
and per-user overlays.

Schema
------
users           — one row per Google account (keyed by Google `sub`) OR
                  local account (keyed by 'local:<username>')
local_users     — username/password accounts (password hashed with pbkdf2)
projects        — lightweight index of every job (fast list/search without
                  reading every job.json)
project_access  — which users can see which projects
user_overlays   — per-user mixer/lyric deltas that don't touch the canonical
                  job.json
"""

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

_db_path: Optional[Path] = None
_lock = threading.Lock()


# ─── Init ────────────────────────────────────────────────────────────────────

def init(db_path: Path) -> None:
    global _db_path
    _db_path = db_path
    _db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        _create_schema(conn)
    _seed_admin()
    _seed_app_settings()
    _reset_auto_shared_playlists()
    migrate_folders_to_playlists()


@contextmanager
def _connect():
    assert _db_path, "db.init() must be called before using the database"
    with _lock:
        conn = sqlite3.connect(str(_db_path), timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id          TEXT PRIMARY KEY,   -- Google `sub` (stable)
            email       TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL DEFAULT '',
            picture     TEXT NOT NULL DEFAULT '',
            role        TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user'
            created_at  TEXT NOT NULL,
            last_seen   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            job_id      TEXT PRIMARY KEY,
            name        TEXT NOT NULL DEFAULT '',
            source_url  TEXT NOT NULL DEFAULT '',   -- YouTube URL or ''
            source_file TEXT NOT NULL DEFAULT '',   -- original filename
            status      TEXT NOT NULL DEFAULT 'queued',
            stem_count  INTEGER NOT NULL DEFAULT 0,
            folder      TEXT NOT NULL DEFAULT '',
            created_by  TEXT,                       -- user.id or NULL for legacy
            created_at  TEXT NOT NULL DEFAULT '',
            updated_at  TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (created_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS project_access (
            job_id      TEXT NOT NULL,
            user_id     TEXT NOT NULL,
            granted_by  TEXT,
            granted_at  TEXT NOT NULL,
            PRIMARY KEY (job_id, user_id),
            FOREIGN KEY (job_id)  REFERENCES projects(job_id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_overlays (
            job_id      TEXT NOT NULL,
            user_id     TEXT NOT NULL,
            overlay     TEXT NOT NULL DEFAULT '{}',  -- JSON blob
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (job_id, user_id),
            FOREIGN KEY (job_id)  REFERENCES projects(job_id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS local_users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            name          TEXT NOT NULL DEFAULT '',
            phone         TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
            is_active     INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT NOT NULL,
            last_seen     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS groups (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT UNIQUE NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_by  TEXT,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_members (
            group_id    INTEGER NOT NULL,
            user_id     TEXT NOT NULL,   -- unified id: Google sub or 'local:N'
            added_at    TEXT NOT NULL,
            PRIMARY KEY (group_id, user_id),
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS project_group_access (
            job_id      TEXT NOT NULL,
            group_id    INTEGER NOT NULL,
            granted_by  TEXT,
            granted_at  TEXT NOT NULL,
            PRIMARY KEY (job_id, group_id),
            FOREIGN KEY (job_id)   REFERENCES projects(job_id) ON DELETE CASCADE,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            owner_id    TEXT,                        -- NULL = admin/system; unified user id for personal
            is_shared   INTEGER NOT NULL DEFAULT 0,  -- 1 = visible to ALL users
            created_by  TEXT,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playlist_projects (
            playlist_id INTEGER NOT NULL,
            job_id      TEXT NOT NULL,
            added_by    TEXT,
            added_at    TEXT NOT NULL,
            PRIMARY KEY (playlist_id, job_id),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
            FOREIGN KEY (job_id)      REFERENCES projects(job_id) ON DELETE CASCADE
        );

        -- Per-user playlist access (individual sharing)
        CREATE TABLE IF NOT EXISTS playlist_access (
            playlist_id INTEGER NOT NULL,
            user_id     TEXT NOT NULL,
            granted_by  TEXT,
            granted_at  TEXT NOT NULL,
            PRIMARY KEY (playlist_id, user_id),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
        );

        -- Per-group playlist access
        CREATE TABLE IF NOT EXISTS playlist_group_access (
            playlist_id INTEGER NOT NULL,
            group_id    INTEGER NOT NULL,
            granted_by  TEXT,
            granted_at  TEXT NOT NULL,
            PRIMARY KEY (playlist_id, group_id),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
            FOREIGN KEY (group_id)    REFERENCES groups(id)    ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key                 TEXT PRIMARY KEY,
            value               TEXT NOT NULL DEFAULT '""',
            type                TEXT NOT NULL DEFAULT 'string',
            label               TEXT NOT NULL DEFAULT '',
            description         TEXT NOT NULL DEFAULT '',
            can_be_overridden   INTEGER NOT NULL DEFAULT 1,
            updated_by          TEXT,
            updated_at          TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS user_settings (
            user_id     TEXT NOT NULL,
            key         TEXT NOT NULL,
            value       TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
        );

        CREATE TABLE IF NOT EXISTS user_favorites (
            user_id     TEXT NOT NULL,
            job_id      TEXT NOT NULL,
            added_at    TEXT NOT NULL,
            PRIMARY KEY (user_id, job_id),
            FOREIGN KEY (job_id) REFERENCES projects(job_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_projects_source_url ON projects(source_url)
            WHERE source_url != '';
        CREATE INDEX IF NOT EXISTS idx_projects_name       ON projects(name);
        CREATE INDEX IF NOT EXISTS idx_projects_updated    ON projects(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_access_user         ON project_access(user_id);
        CREATE INDEX IF NOT EXISTS idx_overlays_user       ON user_overlays(user_id);
        CREATE INDEX IF NOT EXISTS idx_local_users_name    ON local_users(username);
        CREATE INDEX IF NOT EXISTS idx_group_members_user  ON group_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_pga_group           ON project_group_access(group_id);
        CREATE INDEX IF NOT EXISTS idx_playlists_owner     ON playlists(owner_id);
        CREATE INDEX IF NOT EXISTS idx_pp_job              ON playlist_projects(job_id);
        CREATE INDEX IF NOT EXISTS idx_user_settings_user  ON user_settings(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_pl_access_user      ON playlist_access(user_id);
        CREATE INDEX IF NOT EXISTS idx_pl_grp_access_grp   ON playlist_group_access(group_id);
    """)


# ─── Local auth seed ─────────────────────────────────────────────────────────

def _seed_admin() -> None:
    """Create the default admin user if no admin local_user exists yet."""
    from werkzeug.security import generate_password_hash
    with _connect() as conn:
        existing = conn.execute(
            "SELECT id FROM local_users WHERE username='admin'"
        ).fetchone()
        if existing:
            return
        now = datetime.now().isoformat(timespec="seconds")
        conn.execute(
            """INSERT INTO local_users (username, name, phone, password_hash, role, created_at, last_seen)
               VALUES (?,?,?,?,?,?,?)""",
            ("admin", "Administrator", "", generate_password_hash("admin1234"), "admin", now, now),
        )


# ─── Local users ─────────────────────────────────────────────────────────────

def create_local_user(username: str, name: str, phone: str, password_hash: str, role: str = "user") -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT INTO local_users (username, name, phone, password_hash, role, created_at, last_seen)
               VALUES (?,?,?,?,?,?,?)""",
            (username, name, phone, password_hash, role, now, now),
        )
        row = conn.execute("SELECT * FROM local_users WHERE username=?", (username,)).fetchone()
        return dict(row) if row else {}


def get_local_user(username: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM local_users WHERE username=?", (username,)).fetchone()
        return dict(row) if row else None


def get_local_user_by_id(local_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM local_users WHERE id=?", (local_id,)).fetchone()
        return dict(row) if row else None


def local_username_exists(username: str) -> bool:
    with _connect() as conn:
        row = conn.execute("SELECT 1 FROM local_users WHERE username=?", (username,)).fetchone()
        return row is not None


def touch_local_user(local_id: int) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute("UPDATE local_users SET last_seen=? WHERE id=?", (now, local_id))


def update_local_user_password(local_id: int, password_hash: str) -> bool:
    with _connect() as conn:
        conn.execute("UPDATE local_users SET password_hash=? WHERE id=?", (password_hash, local_id))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


def list_local_users(limit: int = 200, offset: int = 0) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, username, name, phone, role, is_active, created_at, last_seen FROM local_users ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]


def set_local_user_role(local_id: int, role: str) -> bool:
    if role not in ("admin", "contributor", "user"):
        return False
    with _connect() as conn:
        conn.execute("UPDATE local_users SET role=? WHERE id=?", (role, local_id))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


def set_local_user_active(local_id: int, is_active: bool) -> bool:
    with _connect() as conn:
        conn.execute("UPDATE local_users SET is_active=? WHERE id=?", (1 if is_active else 0, local_id))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


def local_user_to_unified_id(local_id: int) -> str:
    """Return the string user id used in users/project_access tables for a local user."""
    return f"local:{local_id}"


# ─── Users ───────────────────────────────────────────────────────────────────

def upsert_user(sub: str, email: str, name: str, picture: str, force_role: Optional[str] = None) -> dict:
    """Insert or update a user record. Returns the stored user row as dict."""
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        existing = conn.execute("SELECT role FROM users WHERE id = ?", (sub,)).fetchone()
        if existing:
            # Preserve existing role unless caller explicitly overrides
            role = force_role if force_role else existing["role"]
            conn.execute(
                """UPDATE users SET email=?, name=?, picture=?, role=?, last_seen=?
                   WHERE id=?""",
                (email, name, picture, role, now, sub),
            )
        else:
            role = force_role if force_role else "user"
            conn.execute(
                """INSERT INTO users (id, email, name, picture, role, created_at, last_seen)
                   VALUES (?,?,?,?,?,?,?)""",
                (sub, email, name, picture, role, now, now),
            )
        row = conn.execute("SELECT * FROM users WHERE id=?", (sub,)).fetchone()
        return dict(row) if row else {}


def get_user_by_sub(sub: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (sub,)).fetchone()
        return dict(row) if row else None


def get_user_by_email(email: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        return dict(row) if row else None


def list_users(limit: int = 200, offset: int = 0) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM users ORDER BY last_seen DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]


def set_user_role(user_id: str, role: str) -> bool:
    if role not in ("admin", "contributor", "user"):
        return False
    with _connect() as conn:
        conn.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


def delete_user(user_id: str) -> bool:
    with _connect() as conn:
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


# ─── Projects index ──────────────────────────────────────────────────────────

def upsert_project(
    job_id: str,
    name: str = "",
    source_url: str = "",
    source_file: str = "",
    status: str = "queued",
    stem_count: int = 0,
    folder: str = "",
    created_by: Optional[str] = None,
    created_at: str = "",
    updated_at: str = "",
) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT INTO projects
                (job_id, name, source_url, source_file, status, stem_count,
                 folder, created_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(job_id) DO UPDATE SET
                 name=excluded.name,
                 source_url=excluded.source_url,
                 source_file=excluded.source_file,
                 status=excluded.status,
                 stem_count=excluded.stem_count,
                 folder=excluded.folder,
                 updated_at=excluded.updated_at
            """,
            (
                job_id, name, source_url, source_file, status, stem_count,
                folder, created_by,
                created_at or now, updated_at or now,
            ),
        )


def delete_project(job_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM projects WHERE job_id=?", (job_id,))


def get_project(job_id: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM projects WHERE job_id=?", (job_id,)).fetchone()
        return dict(row) if row else None


def list_projects_for_user(
    user_id: str,
    query: str = "",
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Return (projects, total_count) visible to user_id (non-admin).

    A project is visible if the user has access via ANY of:
      1. Direct project_access entry
      2. Group-based project_group_access
      3. Project is in a playlist shared with all users (is_shared=1)
      4. Project is in a playlist the user has direct playlist_access to
      5. Project is in a playlist shared with a group this user belongs to
    """
    like = f"%{query}%" if query else "%"
    access_filter = """
        p.job_id IN (SELECT a.job_id FROM project_access a WHERE a.user_id = :uid)
        OR p.job_id IN (
            SELECT pga.job_id FROM project_group_access pga
            JOIN group_members gm ON gm.group_id = pga.group_id
            WHERE gm.user_id = :uid
        )
        OR p.job_id IN (
            SELECT pp.job_id FROM playlist_projects pp
            JOIN playlists pl ON pl.id = pp.playlist_id
            WHERE pl.is_shared = 1
        )
        OR p.job_id IN (
            SELECT pp.job_id FROM playlist_projects pp
            JOIN playlist_access pa ON pa.playlist_id = pp.playlist_id
            WHERE pa.user_id = :uid
        )
        OR p.job_id IN (
            SELECT pp.job_id FROM playlist_projects pp
            JOIN playlist_group_access pga ON pga.playlist_id = pp.playlist_id
            JOIN group_members gm ON gm.group_id = pga.group_id
            WHERE gm.user_id = :uid
        )
    """
    params = {"uid": user_id, "like": like}
    with _connect() as conn:
        total = conn.execute(
            f"""SELECT COUNT(DISTINCT p.job_id) FROM projects p
               WHERE ({access_filter})
               AND (p.name LIKE :like OR p.source_url LIKE :like OR p.source_file LIKE :like)""",
            params,
        ).fetchone()[0]
        rows = conn.execute(
            f"""SELECT DISTINCT p.* FROM projects p
               WHERE ({access_filter})
               AND (p.name LIKE :like OR p.source_url LIKE :like OR p.source_file LIKE :like)
               ORDER BY p.updated_at DESC
               LIMIT :limit OFFSET :offset""",
            {**params, "limit": limit, "offset": offset},
        ).fetchall()
        return [dict(r) for r in rows], total


def list_direct_projects_for_user(user_id: str) -> list[dict]:
    """Return projects with a direct project_access entry for this user (admin view)."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT p.job_id, p.name, p.status, p.updated_at, a.granted_at
               FROM projects p
               JOIN project_access a ON a.job_id = p.job_id
               WHERE a.user_id = ?
               ORDER BY a.granted_at DESC""",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_all_projects(
    query: str = "",
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Return (projects, total_count) for admin (all projects)."""
    like = f"%{query}%" if query else "%"
    with _connect() as conn:
        total = conn.execute(
            """SELECT COUNT(*) FROM projects
               WHERE name LIKE ? OR source_url LIKE ? OR source_file LIKE ?""",
            (like, like, like),
        ).fetchone()[0]
        rows = conn.execute(
            """SELECT * FROM projects
               WHERE name LIKE ? OR source_url LIKE ? OR source_file LIKE ?
               ORDER BY updated_at DESC
               LIMIT ? OFFSET ?""",
            (like, like, like, limit, offset),
        ).fetchall()
        return [dict(r) for r in rows], total


def find_project_by_url(source_url: str) -> Optional[dict]:
    """Exact match on source_url (for YouTube dedup check)."""
    if not source_url:
        return None
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM projects WHERE source_url=? ORDER BY updated_at DESC LIMIT 1",
            (source_url,),
        ).fetchone()
        return dict(row) if row else None


# ─── Project access ───────────────────────────────────────────────────────────

def grant_access(job_id: str, user_id: str, granted_by: Optional[str] = None) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO project_access (job_id, user_id, granted_by, granted_at)
               VALUES (?,?,?,?)""",
            (job_id, user_id, granted_by, now),
        )


def revoke_access(job_id: str, user_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "DELETE FROM project_access WHERE job_id=? AND user_id=?",
            (job_id, user_id),
        )


def has_access(job_id: str, user_id: str) -> bool:
    with _connect() as conn:
        # Direct per-user access
        row = conn.execute(
            "SELECT 1 FROM project_access WHERE job_id=? AND user_id=?",
            (job_id, user_id),
        ).fetchone()
        if row:
            return True
        # Group-based project access
        row = conn.execute(
            """SELECT 1 FROM project_group_access pga
               JOIN group_members gm ON gm.group_id = pga.group_id
               WHERE pga.job_id=? AND gm.user_id=?""",
            (job_id, user_id),
        ).fetchone()
        if row:
            return True
        # Playlist-based access (shared with all users)
        row = conn.execute(
            """SELECT 1 FROM playlist_projects pp
               JOIN playlists pl ON pl.id = pp.playlist_id
               WHERE pp.job_id=? AND pl.is_shared=1""",
            (job_id,),
        ).fetchone()
        if row:
            return True
        # Playlist-based access (direct user grant)
        row = conn.execute(
            """SELECT 1 FROM playlist_projects pp
               JOIN playlist_access pa ON pa.playlist_id = pp.playlist_id
               WHERE pp.job_id=? AND pa.user_id=?""",
            (job_id, user_id),
        ).fetchone()
        if row:
            return True
        # Playlist-based access (group grant)
        row = conn.execute(
            """SELECT 1 FROM playlist_projects pp
               JOIN playlist_group_access pga ON pga.playlist_id = pp.playlist_id
               JOIN group_members gm ON gm.group_id = pga.group_id
               WHERE pp.job_id=? AND gm.user_id=?""",
            (job_id, user_id),
        ).fetchone()
        return row is not None


def list_project_access(job_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT a.*, u.email, u.name FROM project_access a
               JOIN users u ON u.id = a.user_id
               WHERE a.job_id=?""",
            (job_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def grant_access_to_all_users(job_id: str, granted_by: Optional[str] = None) -> None:
    """Grant access to every existing user (used when creating a new project)."""
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        users = conn.execute("SELECT id FROM users").fetchall()
        for u in users:
            conn.execute(
                """INSERT OR IGNORE INTO project_access (job_id, user_id, granted_by, granted_at)
                   VALUES (?,?,?,?)""",
                (job_id, u["id"], granted_by, now),
            )


def grant_all_projects_to_user(user_id: str, granted_by: Optional[str] = None) -> None:
    """Grant all existing projects to a newly-registered user."""
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        projects = conn.execute("SELECT job_id FROM projects").fetchall()
        for p in projects:
            conn.execute(
                """INSERT OR IGNORE INTO project_access (job_id, user_id, granted_by, granted_at)
                   VALUES (?,?,?,?)""",
                (p["job_id"], user_id, granted_by, now),
            )


# ─── Groups ───────────────────────────────────────────────────────────────────

def create_group(name: str, description: str = "", created_by: Optional[str] = None) -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            "INSERT INTO groups (name, description, created_by, created_at) VALUES (?,?,?,?)",
            (name, description, created_by, now),
        )
        row = conn.execute("SELECT * FROM groups WHERE name=?", (name,)).fetchone()
        return dict(row) if row else {}


def list_groups() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT g.*,
               (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
               (SELECT COUNT(*) FROM project_group_access pga WHERE pga.group_id = g.id) AS project_count
               FROM groups g ORDER BY g.created_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_group(group_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
        return dict(row) if row else None


def update_group(group_id: int, name: Optional[str] = None, description: Optional[str] = None) -> bool:
    with _connect() as conn:
        if name is not None:
            conn.execute("UPDATE groups SET name=? WHERE id=?", (name, group_id))
        if description is not None:
            conn.execute("UPDATE groups SET description=? WHERE id=?", (description, group_id))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


def delete_group(group_id: int) -> bool:
    with _connect() as conn:
        conn.execute("DELETE FROM groups WHERE id=?", (group_id,))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


def add_group_member(group_id: int, user_id: str) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?,?,?)",
            (group_id, user_id, now),
        )


def remove_group_member(group_id: int, user_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "DELETE FROM group_members WHERE group_id=? AND user_id=?",
            (group_id, user_id),
        )


def list_group_members(group_id: int) -> list[dict]:
    """Return members with display name/email resolved from both users tables."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT user_id, added_at FROM group_members WHERE group_id=? ORDER BY added_at",
            (group_id,),
        ).fetchall()
        result = []
        for r in rows:
            uid = r["user_id"]
            member: dict = {"user_id": uid, "added_at": r["added_at"]}
            if uid.startswith("local:"):
                local_id = int(uid.split(":", 1)[1])
                lu = conn.execute(
                    "SELECT username, name FROM local_users WHERE id=?", (local_id,)
                ).fetchone()
                member["name"] = lu["name"] if lu else ""
                member["email"] = lu["username"] if lu else uid
                member["auth_type"] = "local"
                member["picture"] = ""
            else:
                gu = conn.execute(
                    "SELECT email, name, picture FROM users WHERE id=?", (uid,)
                ).fetchone()
                member["name"] = gu["name"] if gu else ""
                member["email"] = gu["email"] if gu else uid
                member["auth_type"] = "google"
                member["picture"] = gu["picture"] if gu else ""
            result.append(member)
        return result


def grant_group_project_access(job_id: str, group_id: int, granted_by: Optional[str] = None) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO project_group_access (job_id, group_id, granted_by, granted_at) VALUES (?,?,?,?)",
            (job_id, group_id, granted_by, now),
        )


def revoke_group_project_access(job_id: str, group_id: int) -> None:
    with _connect() as conn:
        conn.execute(
            "DELETE FROM project_group_access WHERE job_id=? AND group_id=?",
            (job_id, group_id),
        )


def list_project_group_access(job_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT pga.*, g.name AS group_name, g.description AS group_description
               FROM project_group_access pga
               JOIN groups g ON g.id = pga.group_id
               WHERE pga.job_id=?""",
            (job_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_group_projects(group_id: int) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT p.job_id, p.name, p.status, p.updated_at, pga.granted_at
               FROM project_group_access pga
               JOIN projects p ON p.job_id = pga.job_id
               WHERE pga.group_id=?
               ORDER BY pga.granted_at DESC""",
            (group_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ─── User overlays ───────────────────────────────────────────────────────────

def get_overlay(job_id: str, user_id: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT overlay FROM user_overlays WHERE job_id=? AND user_id=?",
            (job_id, user_id),
        ).fetchone()
        if not row:
            return None
        try:
            return json.loads(row["overlay"])
        except Exception:
            return {}


def save_overlay(job_id: str, user_id: str, overlay: dict) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT INTO user_overlays (job_id, user_id, overlay, updated_at)
               VALUES (?,?,?,?)
               ON CONFLICT(job_id, user_id) DO UPDATE SET
                 overlay=excluded.overlay, updated_at=excluded.updated_at""",
            (job_id, user_id, json.dumps(overlay, ensure_ascii=True), now),
        )


def merge_overlay(base: dict, overlay: dict) -> dict:
    """
    Merge user overlay onto canonical base job data.

    Rules:
    - markers, pitch, tempo, loop: user overlay wins entirely
    - lyrics: user overlay wins if present, otherwise base
    - everything else: base wins (stems, BPM, key, etc.)
    """
    if not overlay:
        return base
    merged = dict(base)

    # Mixer state overlay
    base_ms = dict(base.get("mixer_state") or {})
    overlay_ms = overlay.get("mixer_state") or {}
    if overlay_ms:
        merged_ms = dict(base_ms)
        for field in ("tempo_pct", "pitch_semitones", "loop_start", "loop_end",
                      "loop_enabled", "tracks"):
            if field in overlay_ms:
                merged_ms[field] = overlay_ms[field]
        merged["mixer_state"] = merged_ms

    # Lyrics overlay
    if "lyrics" in overlay:
        merged["lyrics"] = overlay["lyrics"]

    return merged


# ─── Playlists ────────────────────────────────────────────────────────────────

def create_playlist(name: str, owner_id: Optional[str], is_shared: bool, created_by: Optional[str]) -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT INTO playlists (name, owner_id, is_shared, created_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?)""",
            (name, owner_id, 1 if is_shared else 0, created_by, now, now),
        )
        row = conn.execute("SELECT * FROM playlists WHERE rowid=last_insert_rowid()").fetchone()
        return dict(row) if row else {}


def get_playlist(playlist_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM playlists WHERE id=?", (playlist_id,)).fetchone()
        return dict(row) if row else None


def update_playlist(playlist_id: int, name: Optional[str] = None, is_shared: Optional[bool] = None) -> bool:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        if name is not None:
            conn.execute("UPDATE playlists SET name=?, updated_at=? WHERE id=?", (name, now, playlist_id))
        if is_shared is not None:
            conn.execute("UPDATE playlists SET is_shared=?, updated_at=? WHERE id=?",
                         (1 if is_shared else 0, now, playlist_id))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


def delete_playlist(playlist_id: int) -> bool:
    with _connect() as conn:
        conn.execute("DELETE FROM playlists WHERE id=?", (playlist_id,))
        return conn.execute("SELECT changes()").fetchone()[0] > 0


def list_playlists_for_user(user_id: str) -> list[dict]:
    """
    Return playlists visible to user_id:
      - playlists they own
      - playlists with is_shared = 1 (all users)
      - playlists with a direct playlist_access entry for this user
      - playlists shared with a group this user belongs to
    """
    with _connect() as conn:
        rows = conn.execute(
            """SELECT DISTINCT p.*,
               (SELECT COUNT(*) FROM playlist_projects pp WHERE pp.playlist_id = p.id) AS project_count
               FROM playlists p
               WHERE p.owner_id = ?
                  OR p.is_shared = 1
                  OR p.id IN (SELECT pa.playlist_id FROM playlist_access pa WHERE pa.user_id = ?)
                  OR p.id IN (
                      SELECT pga.playlist_id FROM playlist_group_access pga
                      JOIN group_members gm ON gm.group_id = pga.group_id
                      WHERE gm.user_id = ?
                  )
               ORDER BY p.is_shared DESC, p.name ASC""",
            (user_id, user_id, user_id),
        ).fetchall()
        return [dict(r) for r in rows]


def list_all_playlists() -> list[dict]:
    """Return all playlists (admin view), with owner display name resolved."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT p.*,
               (SELECT COUNT(*) FROM playlist_projects pp WHERE pp.playlist_id = p.id) AS project_count
               FROM playlists p
               ORDER BY p.is_shared DESC, p.owner_id ASC, p.name ASC""",
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            owner_id = d.get("owner_id")
            if owner_id:
                if str(owner_id).startswith("local:"):
                    local_id = int(str(owner_id).split(":", 1)[1])
                    lu = conn.execute("SELECT username, name FROM local_users WHERE id=?", (local_id,)).fetchone()
                    d["owner_name"] = lu["name"] if lu else owner_id
                    d["owner_email"] = lu["username"] if lu else owner_id
                else:
                    gu = conn.execute("SELECT email, name FROM users WHERE id=?", (owner_id,)).fetchone()
                    d["owner_name"] = gu["name"] if gu else owner_id
                    d["owner_email"] = gu["email"] if gu else owner_id
            else:
                d["owner_name"] = "Admin"
                d["owner_email"] = ""
            result.append(d)
        return result


def add_project_to_playlist(playlist_id: int, job_id: str, added_by: Optional[str] = None) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO playlist_projects (playlist_id, job_id, added_by, added_at)
               VALUES (?,?,?,?)""",
            (playlist_id, job_id, added_by, now),
        )
        conn.execute("UPDATE playlists SET updated_at=? WHERE id=?", (now, playlist_id))


def remove_project_from_playlist(playlist_id: int, job_id: str) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            "DELETE FROM playlist_projects WHERE playlist_id=? AND job_id=?",
            (playlist_id, job_id),
        )
        conn.execute("UPDATE playlists SET updated_at=? WHERE id=?", (now, playlist_id))


def list_playlist_projects(playlist_id: int) -> list[dict]:
    """Return project rows belonging to a playlist."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT p.*, pp.added_at AS playlist_added_at
               FROM projects p
               JOIN playlist_projects pp ON pp.job_id = p.job_id
               WHERE pp.playlist_id = ?
               ORDER BY pp.added_at DESC""",
            (playlist_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_project_playlists(job_id: str) -> list[dict]:
    """Return all playlists that contain this project."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT pl.id, pl.name, pl.owner_id, pl.is_shared
               FROM playlists pl
               JOIN playlist_projects pp ON pp.playlist_id = pl.id
               WHERE pp.job_id = ?
               ORDER BY pl.name ASC""",
            (job_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def is_project_in_playlist(playlist_id: int, job_id: str) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM playlist_projects WHERE playlist_id=? AND job_id=?",
            (playlist_id, job_id),
        ).fetchone()
        return row is not None


# ── Playlist sharing (user-level) ─────────────────────────────────────────────

def grant_playlist_access(playlist_id: int, user_id: str, granted_by: Optional[str] = None) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO playlist_access (playlist_id, user_id, granted_by, granted_at)
               VALUES (?,?,?,?)""",
            (playlist_id, user_id, granted_by, now),
        )


def revoke_playlist_access(playlist_id: int, user_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "DELETE FROM playlist_access WHERE playlist_id=? AND user_id=?",
            (playlist_id, user_id),
        )


def list_playlist_user_access(playlist_id: int) -> list[dict]:
    """Return users with direct access to this playlist, with name/email resolved."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT user_id, granted_by, granted_at FROM playlist_access WHERE playlist_id=?",
            (playlist_id,),
        ).fetchall()
        result = []
        for r in rows:
            uid = r["user_id"]
            entry: dict = {"user_id": uid, "granted_at": r["granted_at"]}
            if str(uid).startswith("local:"):
                local_id = int(str(uid).split(":", 1)[1])
                lu = conn.execute("SELECT username, name FROM local_users WHERE id=?", (local_id,)).fetchone()
                entry["name"] = lu["name"] if lu else ""
                entry["email"] = lu["username"] if lu else uid
            else:
                gu = conn.execute("SELECT email, name FROM users WHERE id=?", (uid,)).fetchone()
                entry["name"] = gu["name"] if gu else ""
                entry["email"] = gu["email"] if gu else uid
            result.append(entry)
        return result


# ── Playlist sharing (group-level) ────────────────────────────────────────────

def grant_playlist_group_access(playlist_id: int, group_id: int, granted_by: Optional[str] = None) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO playlist_group_access (playlist_id, group_id, granted_by, granted_at)
               VALUES (?,?,?,?)""",
            (playlist_id, group_id, granted_by, now),
        )


def revoke_playlist_group_access(playlist_id: int, group_id: int) -> None:
    with _connect() as conn:
        conn.execute(
            "DELETE FROM playlist_group_access WHERE playlist_id=? AND group_id=?",
            (playlist_id, group_id),
        )


def list_playlist_group_access(playlist_id: int) -> list[dict]:
    """Return groups with access to this playlist."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT pga.group_id, pga.granted_at, g.name AS group_name
               FROM playlist_group_access pga
               JOIN groups g ON g.id = pga.group_id
               WHERE pga.playlist_id=?""",
            (playlist_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ─── App settings ─────────────────────────────────────────────────────────────

_DEFAULT_APP_SETTINGS = [
    {
        "key": "playback_delay_ms",
        "value": 0,
        "type": "number",
        "label": "Playback Delay (ms)",
        "description": "Milliseconds to wait after clicking a stem marker before playback starts. 0 = instant.",
        "can_be_overridden": True,
    },
    {
        "key": "automarker_silence_threshold",
        "value": -50.0,
        "type": "number",
        "label": "Automarker: Silence Threshold (dBFS)",
        "description": "Volume level (in dBFS) below which audio is considered silent for marker detection.",
        "can_be_overridden": True,
    },
    {
        "key": "automarker_min_vocal_duration",
        "value": 1.5,
        "type": "number",
        "label": "Automarker: Min Vocal Duration (s)",
        "description": "Minimum duration (seconds) of vocal audio to be considered a marker region.",
        "can_be_overridden": True,
    },
    {
        "key": "automarker_min_gap_before_marker",
        "value": 0.5,
        "type": "number",
        "label": "Automarker: Min Gap Before Marker (s)",
        "description": "Minimum silence gap (seconds) required before a new marker is placed.",
        "can_be_overridden": True,
    },
]


def _seed_app_settings() -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        for s in _DEFAULT_APP_SETTINGS:
            existing = conn.execute("SELECT key FROM app_settings WHERE key=?", (s["key"],)).fetchone()
            if not existing:
                conn.execute(
                    """INSERT INTO app_settings (key, value, type, label, description, can_be_overridden, updated_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (s["key"], json.dumps(s["value"]), s["type"], s["label"],
                     s["description"], 1 if s["can_be_overridden"] else 0, now),
                )


def list_app_settings() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM app_settings ORDER BY key ASC").fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try:
                d["value"] = json.loads(d["value"])
            except Exception:
                pass
            d["can_be_overridden"] = bool(d["can_be_overridden"])
            result.append(d)
        return result


def get_app_setting(key: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM app_settings WHERE key=?", (key,)).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["value"] = json.loads(d["value"])
        except Exception:
            pass
        d["can_be_overridden"] = bool(d["can_be_overridden"])
        return d


def set_app_setting(
    key: str,
    value,
    type: Optional[str] = None,
    label: Optional[str] = None,
    description: Optional[str] = None,
    can_be_overridden: Optional[bool] = None,
    updated_by: Optional[str] = None,
) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        existing = conn.execute("SELECT key FROM app_settings WHERE key=?", (key,)).fetchone()
        if existing:
            sets = ["value=?", "updated_at=?", "updated_by=?"]
            params: list = [json.dumps(value), now, updated_by]
            if type is not None:
                sets.append("type=?"); params.append(type)
            if label is not None:
                sets.append("label=?"); params.append(label)
            if description is not None:
                sets.append("description=?"); params.append(description)
            if can_be_overridden is not None:
                sets.append("can_be_overridden=?"); params.append(1 if can_be_overridden else 0)
            params.append(key)
            conn.execute(f"UPDATE app_settings SET {', '.join(sets)} WHERE key=?", params)
        else:
            conn.execute(
                """INSERT INTO app_settings (key, value, type, label, description, can_be_overridden, updated_by, updated_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (key, json.dumps(value), type or "string", label or key, description or "",
                 1 if (can_be_overridden is not False) else 0, updated_by, now),
            )


# ─── User settings ────────────────────────────────────────────────────────────

def get_user_settings(user_id: str) -> dict:
    """Return {key: parsed_value} for all settings this user has saved."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT key, value FROM user_settings WHERE user_id=?", (user_id,)
        ).fetchall()
        result = {}
        for r in rows:
            try:
                result[r["key"]] = json.loads(r["value"])
            except Exception:
                result[r["key"]] = r["value"]
        return result


def set_user_setting(user_id: str, key: str, value) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT INTO user_settings (user_id, key, value, updated_at)
               VALUES (?,?,?,?)
               ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
            (user_id, key, json.dumps(value), now),
        )


def set_user_settings(user_id: str, settings: dict) -> None:
    """Bulk-set multiple user settings at once."""
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        for key, value in settings.items():
            conn.execute(
                """INSERT INTO user_settings (user_id, key, value, updated_at)
                   VALUES (?,?,?,?)
                   ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
                (user_id, key, json.dumps(value), now),
            )


def delete_user_setting(user_id: str, key: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM user_settings WHERE user_id=? AND key=?", (user_id, key))


def get_effective_settings(user_id: str) -> dict:
    """
    Return effective settings for a user.
    Resolution order: global default → user override (only for can_be_overridden=True settings).
    """
    global_settings = {s["key"]: s for s in list_app_settings()}
    user_overrides = get_user_settings(user_id) if user_id else {}
    result = {}
    for key, gs in global_settings.items():
        if gs["can_be_overridden"] and key in user_overrides:
            result[key] = user_overrides[key]
        else:
            result[key] = gs["value"]
    return result


# ─── Folder → Playlist migration ─────────────────────────────────────────────

def _reset_auto_shared_playlists() -> None:
    """
    ONE-TIME fixup (tracked by app_settings sentinel): system-created playlists
    (owner_id IS NULL) that were auto-shared via is_shared=1 by the old migration
    code are reset to is_shared=0 so the admin controls sharing explicitly.
    After the first run the sentinel 'migration_playlist_unshare_done' is written
    and this function becomes a no-op on every subsequent restart.
    """
    SENTINEL = "migration_playlist_unshare_done"
    with _connect() as conn:
        already_done = conn.execute(
            "SELECT key FROM app_settings WHERE key=?", (SENTINEL,)
        ).fetchone()
        if already_done:
            return

        rows = conn.execute(
            "SELECT id FROM playlists WHERE owner_id IS NULL AND is_shared=1"
        ).fetchall()
        for r in rows:
            pid = r["id"]
            has_user_access = conn.execute(
                "SELECT 1 FROM playlist_access WHERE playlist_id=?", (pid,)
            ).fetchone()
            has_group_access = conn.execute(
                "SELECT 1 FROM playlist_group_access WHERE playlist_id=?", (pid,)
            ).fetchone()
            if has_user_access or has_group_access:
                continue
            conn.execute("UPDATE playlists SET is_shared=0 WHERE id=?", (pid,))

        # Mark as done so this never runs again
        now = datetime.now().isoformat(timespec="seconds")
        conn.execute(
            """INSERT OR IGNORE INTO app_settings
               (key, value, type, label, description, can_be_overridden, updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (SENTINEL, '"1"', "string", "", "Internal migration sentinel — do not edit.", 0, now),
        )


def migrate_folders_to_playlists(created_by: Optional[str] = None) -> int:
    """
    One-time migration: convert existing projects.folder values to playlists.
    Idempotent — only creates a playlist if one with the same name and owner_id=NULL
    doesn't already exist.  New playlists are created with is_shared=False so the
    admin must explicitly share them via the playlist share controls.
    Returns the number of playlists created.
    """
    with _connect() as conn:
        # Get all unique non-empty folder names
        rows = conn.execute(
            "SELECT DISTINCT folder FROM projects WHERE folder != '' ORDER BY folder ASC"
        ).fetchall()
        folder_names = [r["folder"] for r in rows]

    created = 0
    for name in folder_names:
        # Check if a system playlist (owner_id NULL) with this name already exists
        with _connect() as conn:
            existing = conn.execute(
                "SELECT id FROM playlists WHERE name=? AND owner_id IS NULL",
                (name,),
            ).fetchone()
        if existing:
            playlist_id = existing["id"]
        else:
            pl = create_playlist(name=name, owner_id=None, is_shared=False, created_by=created_by)
            playlist_id = pl["id"]
            created += 1

        # Add all projects in this folder to the playlist (idempotent)
        with _connect() as conn:
            projects = conn.execute(
                "SELECT job_id FROM projects WHERE folder=?", (name,)
            ).fetchall()
        for p in projects:
            add_project_to_playlist(playlist_id, p["job_id"], added_by=created_by)

    return created


# ─── Export / Import playlists ────────────────────────────────────────────────

def export_playlists() -> dict:
    """Return a JSON-serialisable snapshot of all playlists and their project memberships."""
    playlists = list_all_playlists()
    export = {"version": 1, "playlists": []}
    for pl in playlists:
        projects = list_playlist_projects(pl["id"])
        export["playlists"].append({
            "name": pl["name"],
            "owner_id": pl["owner_id"],
            "is_shared": bool(pl["is_shared"]),
            "created_at": pl["created_at"],
            "projects": [p["job_id"] for p in projects],
        })
    return export


def import_playlists(data: dict, imported_by: Optional[str] = None) -> dict:
    """
    Import playlists from exported JSON.
    Existing playlists with the same name + owner_id are skipped (idempotent).
    Returns {"created": N, "skipped": N, "projects_added": N}.
    """
    playlists = data.get("playlists", [])
    created = skipped = projects_added = 0
    for pl_data in playlists:
        name = str(pl_data.get("name", "")).strip()
        if not name:
            continue
        owner_id = pl_data.get("owner_id")
        is_shared = bool(pl_data.get("is_shared", False))
        job_ids = pl_data.get("projects", [])

        # Check for existing playlist with same name + owner
        with _connect() as conn:
            existing = conn.execute(
                "SELECT id FROM playlists WHERE name=? AND (owner_id IS ? OR owner_id=?)",
                (name, owner_id, owner_id),
            ).fetchone()

        if existing:
            playlist_id = existing["id"]
            skipped += 1
        else:
            pl = create_playlist(name=name, owner_id=owner_id, is_shared=is_shared, created_by=imported_by)
            playlist_id = pl["id"]
            created += 1

        for job_id in job_ids:
            # Only add if project exists in DB
            with _connect() as conn:
                proj = conn.execute("SELECT job_id FROM projects WHERE job_id=?", (job_id,)).fetchone()
            if proj:
                add_project_to_playlist(playlist_id, job_id, added_by=imported_by)
                projects_added += 1

    return {"created": created, "skipped": skipped, "projects_added": projects_added}


# ─── User favorites ───────────────────────────────────────────────────────────

def add_favorite(user_id: str, job_id: str) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO user_favorites (user_id, job_id, added_at)
               VALUES (?,?,?)""",
            (user_id, job_id, now),
        )


def remove_favorite(user_id: str, job_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "DELETE FROM user_favorites WHERE user_id=? AND job_id=?",
            (user_id, job_id),
        )


def list_favorites(user_id: str) -> list[str]:
    """Return list of job_ids favorited by this user, ordered by most recently added."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT job_id FROM user_favorites WHERE user_id=? ORDER BY added_at DESC",
            (user_id,),
        ).fetchall()
        return [r["job_id"] for r in rows]


def is_favorite(user_id: str, job_id: str) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM user_favorites WHERE user_id=? AND job_id=?",
            (user_id, job_id),
        ).fetchone()
        return row is not None


# ─── Admin: project access summary ───────────────────────────────────────────

def get_all_projects_access_summary() -> list[dict]:
    """
    Return every project with a breakdown of who can see it and how:
      - via_all_users:  list of playlist names where is_shared=1
      - via_groups:     [{group_id, group_name, via, via_name}]
                          via = "project" | "playlist"
      - via_users:      [{user_id, name, email, via, via_name}]
                          via = "project" | "playlist"
    """
    with _connect() as conn:
        projects = conn.execute(
            "SELECT job_id, name, status, updated_at FROM projects ORDER BY updated_at DESC"
        ).fetchall()

        # ── all-user playlist shares ──────────────────────────────────────
        # {job_id: [playlist_name, ...]}
        all_user_rows = conn.execute(
            """SELECT pp.job_id, pl.name AS playlist_name
               FROM playlist_projects pp
               JOIN playlists pl ON pl.id = pp.playlist_id
               WHERE pl.is_shared = 1"""
        ).fetchall()
        all_user_map: dict[str, list[str]] = {}
        for r in all_user_rows:
            all_user_map.setdefault(r["job_id"], []).append(r["playlist_name"])

        # ── group access ──────────────────────────────────────────────────
        # Direct project_group_access
        grp_direct = conn.execute(
            """SELECT pga.job_id, g.id AS group_id, g.name AS group_name
               FROM project_group_access pga
               JOIN groups g ON g.id = pga.group_id"""
        ).fetchall()
        # Via playlist_group_access
        grp_playlist = conn.execute(
            """SELECT pp.job_id, g.id AS group_id, g.name AS group_name, pl.name AS playlist_name
               FROM playlist_group_access pga
               JOIN groups g ON g.id = pga.group_id
               JOIN playlists pl ON pl.id = pga.playlist_id
               JOIN playlist_projects pp ON pp.playlist_id = pga.playlist_id"""
        ).fetchall()

        # Merge into {job_id: [{group_id, group_name, via, via_name}]}
        # Use (job_id, group_id) dedup — prefer "project" over "playlist" label
        grp_map: dict[str, dict[int, dict]] = {}
        for r in grp_direct:
            grp_map.setdefault(r["job_id"], {})[r["group_id"]] = {
                "group_id": r["group_id"], "group_name": r["group_name"],
                "via": "project", "via_name": "",
            }
        for r in grp_playlist:
            jid = r["job_id"]
            gid = r["group_id"]
            grp_map.setdefault(jid, {})
            if gid not in grp_map[jid]:
                grp_map[jid][gid] = {
                    "group_id": gid, "group_name": r["group_name"],
                    "via": "playlist", "via_name": r["playlist_name"],
                }

        # ── individual user access ────────────────────────────────────────
        # Helper to resolve display name for a user_id
        def _resolve(uid: str) -> tuple[str, str]:
            if str(uid).startswith("local:"):
                lid = int(str(uid).split(":", 1)[1])
                lu = conn.execute(
                    "SELECT username, name FROM local_users WHERE id=?", (lid,)
                ).fetchone()
                return (lu["name"] if lu else "", lu["username"] if lu else uid)
            gu = conn.execute("SELECT name, email FROM users WHERE id=?", (uid,)).fetchone()
            return (gu["name"] if gu else "", gu["email"] if gu else uid)

        # Direct project_access
        usr_direct = conn.execute(
            "SELECT job_id, user_id FROM project_access"
        ).fetchall()
        # Via playlist_access
        usr_playlist = conn.execute(
            """SELECT pp.job_id, pa.user_id, pl.name AS playlist_name
               FROM playlist_access pa
               JOIN playlists pl ON pl.id = pa.playlist_id
               JOIN playlist_projects pp ON pp.playlist_id = pa.playlist_id"""
        ).fetchall()

        # Merge into {job_id: {user_id: {...}}}
        usr_map: dict[str, dict[str, dict]] = {}
        for r in usr_direct:
            name, email = _resolve(r["user_id"])
            usr_map.setdefault(r["job_id"], {})[r["user_id"]] = {
                "user_id": r["user_id"], "name": name, "email": email,
                "via": "project", "via_name": "",
            }
        for r in usr_playlist:
            jid = r["job_id"]
            uid = r["user_id"]
            usr_map.setdefault(jid, {})
            if uid not in usr_map[jid]:
                name, email = _resolve(uid)
                usr_map[jid][uid] = {
                    "user_id": uid, "name": name, "email": email,
                    "via": "playlist", "via_name": r["playlist_name"],
                }

        result = []
        for p in projects:
            jid = p["job_id"]
            result.append({
                "job_id": jid,
                "name": p["name"],
                "status": p["status"],
                "updated_at": p["updated_at"],
                "via_all_users": all_user_map.get(jid, []),
                "via_groups": list((grp_map.get(jid) or {}).values()),
                "via_users": list((usr_map.get(jid) or {}).values()),
            })
        return result
