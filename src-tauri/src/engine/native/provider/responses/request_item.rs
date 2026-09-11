use std::borrow::Cow;

use serde::Serialize;

use super::{FunctionCallOutputContent, FunctionCallOutputPayload, ResponseContent, ResponseItem};

pub(super) struct RequestResponseItem<'a> {
    pub item: &'a ResponseItem,
    pub strip_image_detail: bool,
}

impl Serialize for RequestResponseItem<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.item
            .for_request(self.strip_image_detail)
            .serialize(serializer)
    }
}

impl ResponseItem {
    pub(super) fn for_request(&self, strip_image_detail: bool) -> Cow<'_, Self> {
        if !strip_image_detail || !self.has_image_detail() {
            return Cow::Borrowed(self);
        }
        let mut item = self.clone();
        match &mut item {
            Self::Message { content, .. } => {
                for part in content {
                    if let ResponseContent::InputImage { detail, .. } = part {
                        *detail = None;
                    }
                }
            }
            Self::FunctionCallOutput {
                output: FunctionCallOutputPayload::Content(content),
                ..
            }
            | Self::CustomToolCallOutput {
                output: FunctionCallOutputPayload::Content(content),
                ..
            } => {
                for part in content {
                    if let FunctionCallOutputContent::InputImage { detail, .. } = part {
                        *detail = None;
                    }
                }
            }
            _ => {}
        }
        Cow::Owned(item)
    }

    pub(super) fn equivalent_for_continuation(
        &self,
        other: &Self,
        strip_image_detail: bool,
    ) -> bool {
        match (self, other) {
            (
                Self::Message {
                    id: left_id,
                    role: left_role,
                    content: left_content,
                    phase: left_phase,
                    ..
                },
                Self::Message {
                    id: right_id,
                    role: right_role,
                    content: right_content,
                    phase: right_phase,
                    ..
                },
            ) => {
                left_id == right_id
                    && left_role == right_role
                    && left_phase == right_phase
                    && left_content.len() == right_content.len()
                    && left_content.iter().zip(right_content).all(|(left, right)| {
                        match (left, right) {
                            (
                                ResponseContent::InputImage {
                                    image_url: left_url,
                                    ..
                                },
                                ResponseContent::InputImage {
                                    image_url: right_url,
                                    ..
                                },
                            ) if strip_image_detail => left_url == right_url,
                            _ => left == right,
                        }
                    })
            }
            (
                Self::FunctionCallOutput {
                    id: left_id,
                    call_id: left_call_id,
                    output: left_output,
                },
                Self::FunctionCallOutput {
                    id: right_id,
                    call_id: right_call_id,
                    output: right_output,
                },
            ) => {
                left_id == right_id
                    && left_call_id == right_call_id
                    && output_matches(left_output, right_output, strip_image_detail)
            }
            (
                Self::CustomToolCallOutput {
                    id: left_id,
                    call_id: left_call_id,
                    name: left_name,
                    output: left_output,
                },
                Self::CustomToolCallOutput {
                    id: right_id,
                    call_id: right_call_id,
                    name: right_name,
                    output: right_output,
                },
            ) => {
                left_id == right_id
                    && left_call_id == right_call_id
                    && left_name == right_name
                    && output_matches(left_output, right_output, strip_image_detail)
            }
            (
                Self::Compaction {
                    id: left_id,
                    encrypted_content: left_content,
                    ..
                },
                Self::Compaction {
                    id: right_id,
                    encrypted_content: right_content,
                    ..
                },
            ) => left_id == right_id && left_content == right_content,
            _ => self == other,
        }
    }

    fn has_image_detail(&self) -> bool {
        match self {
            Self::Message { content, .. } => content.iter().any(|part| {
                matches!(
                    part,
                    ResponseContent::InputImage {
                        detail: Some(_),
                        ..
                    }
                )
            }),
            Self::FunctionCallOutput { output, .. } | Self::CustomToolCallOutput { output, .. } => {
                output.content().is_some_and(|content| {
                    content.iter().any(|part| {
                        matches!(
                            part,
                            FunctionCallOutputContent::InputImage {
                                detail: Some(_),
                                ..
                            }
                        )
                    })
                })
            }
            _ => false,
        }
    }
}

fn output_matches(
    left: &FunctionCallOutputPayload,
    right: &FunctionCallOutputPayload,
    strip_image_detail: bool,
) -> bool {
    match (left, right) {
        (FunctionCallOutputPayload::Content(left), FunctionCallOutputPayload::Content(right))
            if strip_image_detail =>
        {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| match (left, right) {
                        (
                            FunctionCallOutputContent::InputImage {
                                image_url: left_url,
                                ..
                            },
                            FunctionCallOutputContent::InputImage {
                                image_url: right_url,
                                ..
                            },
                        ) => left_url == right_url,
                        _ => left == right,
                    })
        }
        _ => left == right,
    }
}
