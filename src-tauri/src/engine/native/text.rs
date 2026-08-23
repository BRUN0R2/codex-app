//! Bounded text presentation helpers shared across engine modules.

pub(super) fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    let end = utf8_prefix_length(value, maximum_bytes);
    value[..end].to_string()
}

pub(super) fn format_duration(seconds: u64) -> String {
    const SECONDS_PER_MINUTE: u64 = 60;
    const SECONDS_PER_HOUR: u64 = 60 * SECONDS_PER_MINUTE;
    const SECONDS_PER_DAY: u64 = 24 * SECONDS_PER_HOUR;
    let days = seconds / SECONDS_PER_DAY;
    let hours = (seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR;
    let minutes = (seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m")
    } else {
        format!("{seconds}s")
    }
}

pub(super) fn utf8_prefix_length(value: &str, maximum_bytes: usize) -> usize {
    if value.len() <= maximum_bytes {
        return value.len();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::format_duration;
    use super::truncate_utf8;

    #[test]
    fn truncate_keeps_multibyte_characters_intact() {
        assert_eq!(truncate_utf8("café", 10), "café");
        assert_eq!(truncate_utf8("çççç", 5), "çç");
    }

    #[test]
    fn format_duration_uses_the_largest_meaningful_unit() {
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(90), "1m");
        assert_eq!(format_duration(3_780), "1h 3m");
        assert_eq!(format_duration(90_000), "1d 1h");
    }
}
