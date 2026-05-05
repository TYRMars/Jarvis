use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::sync::{Arc, Mutex};
use std::thread;

const MAX_LINES: usize = 400;

#[derive(Clone, Default)]
pub struct LogBuffer {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl LogBuffer {
    pub fn push(&self, line: impl Into<String>) {
        let Ok(mut lines) = self.lines.lock() else {
            return;
        };
        lines.push_back(line.into());
        while lines.len() > MAX_LINES {
            lines.pop_front();
        }
    }

    pub fn tail(&self, limit: usize) -> Vec<String> {
        let Ok(lines) = self.lines.lock() else {
            return Vec::new();
        };
        let start = lines.len().saturating_sub(limit);
        lines.iter().skip(start).cloned().collect()
    }

    pub fn pipe<R>(&self, label: &'static str, reader: R)
    where
        R: Read + Send + 'static,
    {
        let logs = self.clone();
        thread::spawn(move || {
            let reader = BufReader::new(reader);
            for line in reader.lines().map_while(Result::ok) {
                logs.push(format!("[{label}] {line}"));
            }
        });
    }
}
