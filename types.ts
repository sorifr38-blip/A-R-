
export interface Message {
  id: string;
  sender: 'user' | 'agent';
  text: string;
  timestamp: Date;
}

export interface CallLog {
  id: string;
  duration: string;
  status: 'completed' | 'missed' | 'active';
  transcript: string;
  timestamp: Date;
}

export interface SMSTemplate {
  id: string;
  name: string;
  content: string;
}

export interface CustomTrigger {
  id: string;
  keyword: string;
  action: 'predefined' | 'ai_guided';
  response: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  timestamp: Date;
  priority: 'low' | 'medium' | 'high';
}

export enum AgentStatus {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  SPEAKING = 'SPEAKING',
  ERROR = 'ERROR'
}
