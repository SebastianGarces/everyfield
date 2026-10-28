//! Timestamps in the store are ISO 8601 UTC strings; the screen shows Eastern Time, Sebastian's clock.

use chrono::{DateTime, Utc};
use chrono_tz::America::New_York;

pub fn parse(ts: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// `HH:MM:SS` in Eastern Time, or the raw prefix when the string is not a timestamp.
pub fn clock_et(ts: &str) -> String {
    match parse(ts) {
        Some(d) => d.with_timezone(&New_York).format("%H:%M:%S").to_string(),
        None => ts.chars().take(8).collect(),
    }
}

/// `MM-DD HH:MM:SS EDT|EST`.
pub fn stamp_et(ts: &str) -> String {
    match parse(ts) {
        Some(d) => d
            .with_timezone(&New_York)
            .format("%m-%d %H:%M:%S %Z")
            .to_string(),
        None => ts.to_string(),
    }
}

/// Compact age: `12s`, `3m`, `2h`, `5d`. Future or unparsable stamps give `-`.
pub fn ago(ts: &str, now: DateTime<Utc>) -> String {
    let Some(then) = parse(ts) else {
        return "-".into();
    };
    let secs = (now - then).num_seconds();
    if secs < 0 {
        return "-".into();
    }
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eastern_time_follows_daylight_saving() {
        assert_eq!(clock_et("2026-10-27T21:05:09.000Z"), "17:05:09");
        assert_eq!(stamp_et("2026-10-27T21:05:09.000Z"), "10-27 17:05:09 EDT");
        assert_eq!(stamp_et("2026-01-15T21:05:09Z"), "01-15 16:05:09 EST");
        assert_eq!(clock_et("garbage"), "garbage");
    }

    #[test]
    fn ages_are_compact() {
        let now = parse("2026-10-27T21:00:00Z").unwrap();
        assert_eq!(ago("2026-10-27T20:59:48Z", now), "12s");
        assert_eq!(ago("2026-10-27T20:57:00Z", now), "3m");
        assert_eq!(ago("2026-10-27T19:00:00Z", now), "2h");
        assert_eq!(ago("2026-10-22T21:00:00Z", now), "5d");
        assert_eq!(ago("2026-10-28T21:00:00Z", now), "-");
        assert_eq!(ago("", now), "-");
    }
}
