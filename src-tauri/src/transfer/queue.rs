use crate::transfer::resume::{TransferMode, DEFAULT_ASCII_MASK};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
    LocalCopy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferTaskStatus {
    Queued,
    Running,
    Paused,
    Conflict,
    Completed,
    Failed,
    Skipped,
    Cancelled,
}

impl TransferTaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Skipped | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOptions {
    pub direction: TransferDirection,
    pub session_id: Option<String>,
    pub is_move: bool,
    pub preserve_timestamp: bool,
    pub preserve_rights: bool,
    pub octal_rights: Option<String>,
    pub transfer_mode: TransferMode,
    pub ascii_file_mask: String,
    pub file_mask: String,
    pub newer_only: bool,
    pub exclude_hidden: bool,
    pub exclude_empty_dirs: bool,
    pub use_filepart: bool,
    pub remove_bom_eof: bool,
    pub speed_limit_kbps: u64,
    pub background_queue: bool,
    pub overwrite_policy: String,
}

impl Default for TransferOptions {
    fn default() -> Self {
        Self {
            direction: TransferDirection::Upload,
            session_id: None,
            is_move: false,
            preserve_timestamp: true,
            preserve_rights: false,
            octal_rights: None,
            transfer_mode: TransferMode::Binary,
            ascii_file_mask: DEFAULT_ASCII_MASK.to_string(),
            file_mask: "*".to_string(),
            newer_only: false,
            exclude_hidden: false,
            exclude_empty_dirs: false,
            use_filepart: true,
            remove_bom_eof: false,
            speed_limit_kbps: 0,
            background_queue: true,
            overwrite_policy: "ask".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferItem {
    pub id: String,
    pub batch_id: String,
    pub session_id: Option<String>,
    pub direction: TransferDirection,
    pub is_move: bool,
    pub source_path: String,
    pub target_path: String,
    pub file_name: String,
    pub is_dir: bool,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub resumed_from_bytes: u64,
    pub speed_bps: u64,
    pub eta_seconds: Option<u64>,
    pub status: TransferTaskStatus,
    pub error: Option<String>,
    pub source_mtime_ms: Option<u64>,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub options: TransferOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPrompt {
    pub item_id: String,
    pub batch_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    pub source_path: String,
    pub target_path: String,
    pub source_size: u64,
    pub target_size: u64,
    pub source_mtime_ms: Option<u64>,
    pub target_mtime_ms: Option<u64>,
    pub has_filepart: bool,
    pub filepart_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferQueueSnapshot {
    pub items: Vec<TransferItem>,
    pub active_conflict: Option<ConflictPrompt>,
    pub max_concurrent: usize,
    pub global_speed_limit_kbps: u64,
    pub total_speed_bps: u64,
    pub active_count: usize,
    pub queued_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn compute_eta_seconds(remaining_bytes: u64, speed_bps: u64) -> Option<u64> {
    if speed_bps == 0 {
        None
    } else if remaining_bytes == 0 {
        Some(0)
    } else {
        Some(remaining_bytes.div_ceil(speed_bps))
    }
}

pub fn compute_chunk_throttle_delay_ms(
    chunk_bytes: usize,
    speed_limit_kbps: u64,
    active_workers: usize,
) -> u64 {
    if speed_limit_kbps == 0 || chunk_bytes == 0 {
        return 0;
    }
    let workers = active_workers.max(1) as u64;
    let total_bps = speed_limit_kbps.saturating_mul(1024);
    let per_worker_bps = (total_bps / workers).max(1024);
    ((chunk_bytes as u64).saturating_mul(1000)) / per_worker_bps
}

pub struct TransferQueueState {
    pub items: Vec<TransferItem>,
    pub max_concurrent: usize,
    pub global_speed_limit_kbps: u64,
    pub pending_conflicts: Vec<ConflictPrompt>,
    pub batch_policies: HashMap<String, String>,
}

impl TransferQueueState {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            items: Vec::new(),
            max_concurrent: max_concurrent.clamp(1, 8),
            global_speed_limit_kbps: 0,
            pending_conflicts: Vec::new(),
            batch_policies: HashMap::new(),
        }
    }

    pub fn enqueue(&mut self, new_items: Vec<TransferItem>) {
        self.items.extend(new_items);
    }

    pub fn running_count(&self) -> usize {
        self.items
            .iter()
            .filter(|it| {
                matches!(
                    it.status,
                    TransferTaskStatus::Running | TransferTaskStatus::Conflict
                )
            })
            .count()
    }

    pub fn claim_next_queued(&mut self) -> Option<TransferItem> {
        if self.running_count() >= self.max_concurrent {
            return None;
        }
        let item = self
            .items
            .iter_mut()
            .find(|it| it.status == TransferTaskStatus::Queued)?;
        item.status = TransferTaskStatus::Running;
        item.error = None;
        item.finished_at_ms = None;
        if item.started_at_ms.is_none() {
            item.started_at_ms = Some(now_millis());
        }
        Some(item.clone())
    }

    pub fn find_item_mut(&mut self, item_id: &str) -> Option<&mut TransferItem> {
        self.items.iter_mut().find(|it| it.id == item_id)
    }

    pub fn set_item_paused(&mut self, item_id: &str, paused: bool) -> bool {
        if let Some(it) = self.find_item_mut(item_id) {
            if paused && matches!(it.status, TransferTaskStatus::Queued | TransferTaskStatus::Running) {
                it.status = TransferTaskStatus::Paused;
                it.speed_bps = 0;
                it.eta_seconds = None;
                return true;
            }
            if !paused && it.status == TransferTaskStatus::Paused {
                it.status = TransferTaskStatus::Queued;
                return true;
            }
        }
        false
    }

    pub fn set_item_cancelled(&mut self, item_id: &str) -> bool {
        self.pending_conflicts.retain(|c| c.item_id != item_id);
        if let Some(it) = self.find_item_mut(item_id) {
            if !it.status.is_terminal() {
                it.status = TransferTaskStatus::Cancelled;
                it.speed_bps = 0;
                it.eta_seconds = None;
                it.finished_at_ms = Some(now_millis());
                return true;
            }
        }
        false
    }

    pub fn retry_item(&mut self, item_id: &str) -> bool {
        if let Some(it) = self.find_item_mut(item_id) {
            if matches!(
                it.status,
                TransferTaskStatus::Failed | TransferTaskStatus::Cancelled | TransferTaskStatus::Skipped
            ) {
                it.status = TransferTaskStatus::Queued;
                it.error = None;
                it.speed_bps = 0;
                it.eta_seconds = None;
                it.finished_at_ms = None;
                return true;
            }
        }
        false
    }

    pub fn remove_item(&mut self, item_id: &str) -> bool {
        let len_before = self.items.len();
        self.items.retain(|it| it.id != item_id);
        self.pending_conflicts.retain(|c| c.item_id != item_id);
        self.items.len() != len_before
    }

    pub fn clear_finished(&mut self) -> usize {
        let len_before = self.items.len();
        self.items.retain(|it| !it.status.is_terminal());
        len_before - self.items.len()
    }

    pub fn snapshot(&self) -> TransferQueueSnapshot {
        let mut total_speed_bps = 0u64;
        let mut active_count = 0usize;
        let mut queued_count = 0usize;
        let mut completed_count = 0usize;
        let mut failed_count = 0usize;

        for it in &self.items {
            match it.status {
                TransferTaskStatus::Running | TransferTaskStatus::Conflict => {
                    active_count += 1;
                    total_speed_bps = total_speed_bps.saturating_add(it.speed_bps);
                }
                TransferTaskStatus::Queued => queued_count += 1,
                TransferTaskStatus::Completed => completed_count += 1,
                TransferTaskStatus::Failed => failed_count += 1,
                TransferTaskStatus::Paused
                | TransferTaskStatus::Skipped
                | TransferTaskStatus::Cancelled => {}
            }
        }

        TransferQueueSnapshot {
            items: self.items.clone(),
            active_conflict: self.pending_conflicts.first().cloned(),
            max_concurrent: self.max_concurrent,
            global_speed_limit_kbps: self.global_speed_limit_kbps,
            total_speed_bps,
            active_count,
            queued_count,
            completed_count,
            failed_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_item(id: &str) -> TransferItem {
        TransferItem {
            id: id.to_string(),
            batch_id: "batch_1".to_string(),
            session_id: Some("tab-1".to_string()),
            direction: TransferDirection::Upload,
            is_move: false,
            source_path: format!("C:/tmp/{}.bin", id),
            target_path: format!("/remote/{}.bin", id),
            file_name: format!("{}.bin", id),
            is_dir: false,
            total_bytes: 1024,
            transferred_bytes: 0,
            resumed_from_bytes: 0,
            speed_bps: 0,
            eta_seconds: None,
            status: TransferTaskStatus::Queued,
            error: None,
            source_mtime_ms: Some(1_700_000_000_000),
            started_at_ms: None,
            finished_at_ms: None,
            options: TransferOptions::default(),
        }
    }

    #[test]
    fn queue_enqueue_pause_resume_cancel_and_retry() {
        let mut state = TransferQueueState::new(2);
        state.enqueue(vec![make_item("a"), make_item("b"), make_item("c")]);
        assert_eq!(state.snapshot().queued_count, 3);

        let first = state.claim_next_queued().unwrap();
        let second = state.claim_next_queued().unwrap();
        assert_eq!(first.id, "a");
        assert_eq!(second.id, "b");
        assert!(state.claim_next_queued().is_none());

        assert!(state.set_item_paused("a", true));
        assert_eq!(state.find_item_mut("a").unwrap().status, TransferTaskStatus::Paused);
        // Slot freed, c can now run
        let third = state.claim_next_queued().unwrap();
        assert_eq!(third.id, "c");

        assert!(state.set_item_paused("a", false));
        assert_eq!(state.find_item_mut("a").unwrap().status, TransferTaskStatus::Queued);

        assert!(state.set_item_cancelled("b"));
        assert_eq!(
            state.find_item_mut("b").unwrap().status,
            TransferTaskStatus::Cancelled
        );
        assert!(state.retry_item("b"));
        assert_eq!(state.find_item_mut("b").unwrap().status, TransferTaskStatus::Queued);
    }

    #[test]
    fn eta_and_bandwidth_throttle_calculation() {
        assert_eq!(compute_eta_seconds(10_000, 2_500), Some(4));
        assert_eq!(compute_eta_seconds(10_001, 2_500), Some(5));
        assert_eq!(compute_eta_seconds(0, 1_000), Some(0));
        assert_eq!(compute_eta_seconds(10_000, 0), None);

        assert_eq!(compute_chunk_throttle_delay_ms(65_536, 0, 2), 0);
        assert_eq!(compute_chunk_throttle_delay_ms(65_536, 64, 1), 1000);
        assert_eq!(compute_chunk_throttle_delay_ms(65_536, 64, 2), 2000);
    }
}
