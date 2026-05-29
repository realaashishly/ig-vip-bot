export interface MetaRecipient {
    id: string;
}

export interface MetaMessageData {
    text: string;
}

export interface MetaMessagePayload {
    recipient: MetaRecipient;
    message: MetaMessageData;
}

export interface MetaApiError {
    message: string;
    type: string;
    code: number;
    fbtrace_id: string;
}

export interface MetaMessageResponse {
    recipient_id?: string;
    message_id?: string;
    error?: MetaApiError; 
}

export interface InstagramProfile {
    name?: string;
    username?: string;
    profile_pic?: string;
    error?: MetaApiError;
}

