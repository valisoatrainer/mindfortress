-- ============================================================================
-- MIND FORTRESS — Schéma SQLite Natif / libSQL (Compatible Turso + Vercel)
-- ============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lichess_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    perfs_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_lichess_id ON users(lichess_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS puzzles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    title TEXT NOT NULL,
    fen TEXT NOT NULL,
    theme TEXT NOT NULL DEFAULT 'fork',
    type TEXT NOT NULL DEFAULT 'tactique',
    diff INTEGER NOT NULL DEFAULT 2,
    side TEXT NOT NULL DEFAULT 'Blancs',
    solution TEXT NOT NULL,
    solution_moves TEXT NOT NULL DEFAULT '[]',
    hint TEXT DEFAULT '',
    custom INTEGER NOT NULL DEFAULT 0,
    solved INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    best_time_sec INTEGER NOT NULL DEFAULT 0,
    box INTEGER NOT NULL DEFAULT 1,
    -- Colonnes FSRS (Free Spaced Repetition Scheduler) & Woodpecker
    fsrs_state INTEGER NOT NULL DEFAULT 0,          -- 0: New, 1: Learning, 2: Review, 3: Relearning
    fsrs_stability REAL NOT NULL DEFAULT 0.0,       -- S (Stability in days)
    fsrs_difficulty REAL NOT NULL DEFAULT 5.0,      -- D in [1.0, 10.0]
    fsrs_elapsed_days INTEGER NOT NULL DEFAULT 0,
    fsrs_scheduled_days INTEGER NOT NULL DEFAULT 0,
    fsrs_reps INTEGER NOT NULL DEFAULT 0,
    fsrs_lapses INTEGER NOT NULL DEFAULT 0,
    fsrs_last_review TEXT,
    fsrs_due_date TEXT,
    woodpecker_cycle INTEGER NOT NULL DEFAULT 1,
    user_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_puzzle_progress (
    user_id INTEGER NOT NULL,
    puzzle_id INTEGER NOT NULL,
    solved INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    best_time_sec INTEGER NOT NULL DEFAULT 0,
    box INTEGER NOT NULL DEFAULT 1,
    fsrs_state INTEGER NOT NULL DEFAULT 0,
    fsrs_stability REAL NOT NULL DEFAULT 0.0,
    fsrs_difficulty REAL NOT NULL DEFAULT 5.0,
    fsrs_elapsed_days INTEGER NOT NULL DEFAULT 0,
    fsrs_scheduled_days INTEGER NOT NULL DEFAULT 0,
    fsrs_reps INTEGER NOT NULL DEFAULT 0,
    fsrs_lapses INTEGER NOT NULL DEFAULT 0,
    fsrs_last_review TEXT,
    fsrs_due_date TEXT,
    woodpecker_cycle INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, puzzle_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_upp_user ON user_puzzle_progress(user_id);

CREATE INDEX IF NOT EXISTS idx_puzzles_theme ON puzzles(theme);
CREATE INDEX IF NOT EXISTS idx_puzzles_box ON puzzles(box);
CREATE INDEX IF NOT EXISTS idx_puzzles_fsrs_due ON puzzles(fsrs_due_date);

CREATE TABLE IF NOT EXISTS fsrs_review_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    puzzle_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4), -- 1: Again, 2: Hard, 3: Good, 4: Easy
    state INTEGER NOT NULL DEFAULT 0,
    elapsed_days INTEGER NOT NULL DEFAULT 0,
    scheduled_days INTEGER NOT NULL DEFAULT 0,
    solve_time_sec INTEGER NOT NULL DEFAULT 0,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fsrs_logs_puzzle ON fsrs_review_logs(puzzle_id);
CREATE INDEX IF NOT EXISTS idx_fsrs_logs_date ON fsrs_review_logs(reviewed_at);

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    at_label TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL DEFAULT 'Force',
    puzzle_id INTEGER,
    text TEXT NOT NULL,
    theme TEXT DEFAULT 'fork',
    diff INTEGER DEFAULT 2,
    time_sec INTEGER DEFAULT 0,
    success INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    emotion TEXT DEFAULT 'calme',
    intensity INTEGER DEFAULT 3,
    notes TEXT DEFAULT '',
    FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);

CREATE TABLE IF NOT EXISTS contextual_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    log_id INTEGER,
    linked_text TEXT DEFAULT 'Séance libre — hors log',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    at_label TEXT,
    note TEXT NOT NULL,
    before_emotion TEXT DEFAULT 'stress',
    after_emotion TEXT DEFAULT 'calme',
    before_intensity INTEGER DEFAULT 3,
    after_intensity INTEGER DEFAULT 2,
    lieu TEXT DEFAULT 'Maison',
    bruit TEXT DEFAULT 'Calme',
    sommeil TEXT DEFAULT 'Bon',
    fatigue INTEGER DEFAULT 2,
    pression TEXT DEFAULT 'Entraînement',
    tag TEXT DEFAULT '',
    FOREIGN KEY (log_id) REFERENCES logs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_created_at ON contextual_journal(created_at);
CREATE INDEX IF NOT EXISTS idx_journal_log_id ON contextual_journal(log_id);

CREATE TABLE IF NOT EXISTS completed_days (
    day_key TEXT PRIMARY KEY,
    status TEXT DEFAULT 'done',
    sessions_count INTEGER DEFAULT 1,
    notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_completed_days (
    user_id INTEGER NOT NULL,
    day_key TEXT NOT NULL,
    status TEXT DEFAULT 'done',
    sessions_count INTEGER DEFAULT 1,
    notes TEXT DEFAULT '',
    PRIMARY KEY (user_id, day_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blindage_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    wish TEXT DEFAULT '',
    outcome TEXT DEFAULT '',
    obstacle TEXT DEFAULT '',
    plan TEXT DEFAULT '',
    col1 TEXT DEFAULT '',
    col2 TEXT DEFAULT '',
    col3 TEXT DEFAULT '',
    mode TEXT DEFAULT 'daily',
    breathing_cycles INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_blindage_created_at ON blindage_entries(created_at);

CREATE TABLE IF NOT EXISTS lichess_games (
    id TEXT PRIMARY KEY,
    white TEXT,
    black TEXT,
    result TEXT,
    speed TEXT,
    played_at TEXT,
    pgn TEXT NOT NULL,
    hour_of_day INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_lichess_games (
    user_id INTEGER NOT NULL,
    game_id TEXT NOT NULL,
    white TEXT,
    black TEXT,
    result TEXT,
    speed TEXT,
    played_at TEXT,
    pgn TEXT NOT NULL,
    hour_of_day INTEGER,
    opening TEXT DEFAULT 'Ouverture Classique',
    critical_fen TEXT DEFAULT '',
    critical_move_san TEXT DEFAULT '',
    critical_solution_moves TEXT DEFAULT '[]',
    critical_side TEXT DEFAULT 'Blancs',
    critical_move_number INTEGER DEFAULT 15,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, game_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS opponents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    fide_elo INTEGER,
    lichess_username TEXT DEFAULT '',
    style TEXT DEFAULT 'Solide',
    psych_profile TEXT DEFAULT '',
    white_repertoire TEXT DEFAULT '',
    black_repertoire TEXT DEFAULT '',
    reference_pgn TEXT DEFAULT '',
    match_plan TEXT DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS opening_repertoire (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    side TEXT NOT NULL DEFAULT 'Blancs',
    name TEXT NOT NULL,
    eco TEXT DEFAULT '',
    moves TEXT NOT NULL,
    plan TEXT DEFAULT '',
    start_fen TEXT DEFAULT 'start',
    mastery INTEGER NOT NULL DEFAULT 50,
    fsrs_stability REAL NOT NULL DEFAULT 0.0,
    fsrs_difficulty REAL NOT NULL DEFAULT 5.0,
    fsrs_due_date TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tournament_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    tournament_name TEXT DEFAULT 'Championnat de Madagascar 2027',
    round_number INTEGER NOT NULL DEFAULT 1,
    opponent_id INTEGER,
    opponent_name TEXT DEFAULT '',
    side TEXT NOT NULL DEFAULT 'Blancs',
    result TEXT NOT NULL DEFAULT '1',
    had_zeitnot INTEGER NOT NULL DEFAULT 0,
    critical_moment TEXT DEFAULT '',
    emotion TEXT DEFAULT 'Calme',
    lesson TEXT DEFAULT '',
    played_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rounds_user ON tournament_rounds(user_id);
