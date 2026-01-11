-- Voice AI Receptionist Database Schema
-- PostgreSQL 14+

DROP TABLE IF EXISTS call_transcripts CASCADE;
DROP TABLE IF EXISTS appointments CASCADE;
DROP TABLE IF EXISTS insurance CASCADE;
DROP TABLE IF EXISTS patients CASCADE;

CREATE TABLE patients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    date_of_birth DATE,
    call_sid VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_phone UNIQUE(phone)
);

CREATE TABLE insurance (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    provider VARCHAR(255),
    member_id VARCHAR(50),
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE appointments (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    appointment_date DATE NOT NULL,
    appointment_time TIME NOT NULL,
    reason TEXT,
    status VARCHAR(50) DEFAULT 'scheduled',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE call_transcripts (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id),
    call_sid VARCHAR(100) NOT NULL,
    transcript JSONB,
    call_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_patients_phone ON patients(phone);
CREATE INDEX idx_appointments_date ON appointments(appointment_date);

CREATE VIEW patient_details AS
SELECT 
    p.id, p.name, p.phone, p.email,
    i.provider as insurance_provider,
    i.member_id as insurance_id,
    COUNT(a.id) as total_appointments
FROM patients p
LEFT JOIN insurance i ON p.id = i.patient_id
LEFT JOIN appointments a ON p.id = a.patient_id
GROUP BY p.id, p.name, p.phone, p.email, i.provider, i.member_id;

INSERT INTO patients (name, phone, email, date_of_birth) VALUES
    ('Test Patient', '5551234567', 'test@example.com', '1990-01-01');