-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Table for system settings
create table if not exists system_settings (
    id text primary key,
    data jsonb not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Table for users
create table if not exists users (
    email text primary key,
    name text not null,
    password text not null,
    role text not null,
    phone text,
    dob date,
    gender text,
    height numeric,
    weight numeric,
    goal text,
    status text default 'Active'::text,
    avatar text,
    first_login boolean default false,
    blood_group text,
    allergies text,
    medications text,
    conditions text,
    emergency_name text,
    emergency_phone text,
    preferred_coach text,
    diet_preference text,
    activity_level text,
    streak_count integer default 0,
    health_profile jsonb,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Table for daily wellness logs
create table if not exists wellness_logs (
    id text primary key,
    user_email text references users(email) on delete cascade,
    date date not null,
    weight numeric,
    calories_intake integer,
    calories_burned integer,
    water_ml integer,
    steps integer,
    sleep_hours numeric,
    mood text,
    heart_rate integer,
    blood_pressure text,
    notes text,
    meals jsonb default '[]'::jsonb,
    activities jsonb default '[]'::jsonb,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Table for AI wellness reports
create table if not exists ai_reports (
    id text primary key,
    user_email text references users(email) on delete cascade,
    date date not null,
    coaching_advice text,
    metrics jsonb default '{}'::jsonb,
    generated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Table for community notice board & posts
create table if not exists posts (
    id text primary key,
    title text not null,
    content text not null,
    author text not null,
    author_avatar text,
    category text,
    timestamp timestamp with time zone default timezone('utc'::text, now()) not null,
    likes integer default 0,
    liked_by jsonb default '[]'::jsonb,
    comments jsonb default '[]'::jsonb
);

-- Table for appointments
create table if not exists appointments (
    id text primary key,
    user_email text references users(email) on delete cascade,
    coach text not null,
    date date not null,
    time text not null,
    type text not null,
    status text default 'Scheduled'::text,
    notes text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Table for noticeboard events
create table if not exists events (
    id text primary key,
    title text not null,
    date date not null,
    time text not null,
    location text not null,
    description text,
    attendees jsonb default '[]'::jsonb,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Table for audit logs
create table if not exists audit_logs (
    id text primary key,
    timestamp timestamp with time zone default timezone('utc'::text, now()) not null,
    operator text not null,
    event_type text not null,
    resource text not null,
    details text
);

-- Table for emails outbox
create table if not exists emails (
    id text primary key,
    timestamp timestamp with time zone default timezone('utc'::text, now()) not null,
    recipient text not null,
    subject text not null,
    template_name text not null,
    status text default 'Delivered'::text
);

-- Table for notifications outbox
create table if not exists notifications (
    id text primary key,
    timestamp timestamp with time zone default timezone('utc'::text, now()) not null,
    recipient text not null,
    message text not null,
    type text not null,
    status text default 'Sent'::text
);

-- Table for background automation jobs
create table if not exists automation_jobs (
    id text primary key,
    name text not null,
    type text not null,
    status text not null,
    run_time timestamp with time zone not null,
    user_email text,
    retries integer default 0,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
