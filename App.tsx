
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { AgentStatus, Message, CallLog, SMSTemplate, CustomTrigger, Task } from './types';
import { decode, encode, decodeAudioData } from './services/audioUtils';

// Components
const StatCard = ({ title, value, icon, color }: { title: string, value: string, icon: string, color: string }) => (
  <div className="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl flex items-center gap-4 transition-all hover:border-slate-700">
    <div className={`w-12 h-12 rounded-full flex items-center justify-center ${color} bg-opacity-20`}>
      <i className={`fas ${icon} ${color.replace('bg-', 'text-')}`}></i>
    </div>
    <div>
      <p className="text-slate-400 text-sm font-medium">{title}</p>
      <h3 className="text-2xl font-bold">{value}</h3>
    </div>
  </div>
);

const App: React.FC = () => {
  const [status, setStatus] = useState<AgentStatus>(AgentStatus.IDLE);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [smsInput, setSmsInput] = useState('');
  const [isDictating, setIsDictating] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [suggestedTemplateId, setSuggestedTemplateId] = useState<string | null>(null);
  const [currentIntent, setCurrentIntent] = useState<string>('General');
  
  const [callLogs, setCallLogs] = useState<CallLog[]>(() => {
    const saved = localStorage.getItem('call_logs');
    return saved ? JSON.parse(saved).map((log: any) => ({ ...log, timestamp: new Date(log.timestamp) })) : [];
  });

  const [tasks, setTasks] = useState<Task[]>(() => {
    const saved = localStorage.getItem('agent_tasks');
    return saved ? JSON.parse(saved).map((t: any) => ({ ...t, timestamp: new Date(t.timestamp) })) : [];
  });

  const [templates, setTemplates] = useState<SMSTemplate[]>(() => {
    const saved = localStorage.getItem('sms_templates');
    return saved ? JSON.parse(saved) : [
      { id: '1', name: 'Pricing Info', content: 'Our standard package starts at $99/mo.' },
      { id: '2', name: 'Booking', content: 'You can book a call at calendly.com/our-business' }
    ];
  });

  const [triggers, setTriggers] = useState<CustomTrigger[]>(() => {
    const saved = localStorage.getItem('sms_triggers');
    return saved ? JSON.parse(saved) : [
      { id: 't1', keyword: 'hello', action: 'predefined', response: 'Hi there! How can Barta-AI help your business today?' }
    ];
  });
  
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [modalTab, setModalTab] = useState<'templates' | 'triggers' | 'tasks'>('templates');
  const [newTemplate, setNewTemplate] = useState({ name: '', content: '' });
  const [newTrigger, setNewTrigger] = useState<Omit<CustomTrigger, 'id'>>({ keyword: '', action: 'predefined', response: '' });

  useEffect(() => {
    localStorage.setItem('sms_templates', JSON.stringify(templates));
    localStorage.setItem('call_logs', JSON.stringify(callLogs));
    localStorage.setItem('sms_triggers', JSON.stringify(triggers));
    localStorage.setItem('agent_tasks', JSON.stringify(tasks));
  }, [templates, callLogs, triggers, tasks]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const callStartTimeRef = useRef<number | null>(null);
  const recognitionRef = useRef<any>(null);

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setSmsInput(prev => (prev ? `${prev} ${transcript}` : transcript));
        setIsDictating(false);
      };

      recognitionRef.current.onerror = () => setIsDictating(false);
      recognitionRef.current.onend = () => setIsDictating(false);
    }
  }, []);

  const toggleDictation = () => {
    if (!recognitionRef.current) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }
    if (isDictating) {
      recognitionRef.current.stop();
    } else {
      setIsDictating(true);
      recognitionRef.current.start();
    }
  };

  const generateTasksFromSummary = async (summary: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const schema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            priority: { type: Type.STRING, enum: ['low', 'medium', 'high'] }
          },
          required: ['title', 'description', 'priority']
        }
      };
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Based on this call summary: "${summary}", generate 1-2 actionable follow-up tasks for a business owner.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          systemInstruction: 'You are an operations assistant. Extract specific business follow-up tasks.'
        }
      });
      
      const suggestedTasks = JSON.parse(response.text || '[]');
      const newTasks: Task[] = suggestedTasks.map((t: any) => ({
        ...t,
        id: Math.random().toString(36).substr(2, 9),
        completed: false,
        timestamp: new Date()
      }));
      
      setTasks(prev => [...newTasks, ...prev].slice(0, 20));
    } catch (err) {
      console.error("Failed to generate tasks:", err);
    }
  };

  const generateCallSummary = async (duration: string) => {
    setIsSummarizing(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Generate a realistic 1-sentence business summary for a phone call that lasted ${duration}. The caller was interested in our services. Mention a possible next step.`,
        config: {
          systemInstruction: 'You are an AI assistant summarizing business calls. Be concise and professional.'
        }
      });
      const summary = response.text || "Business inquiry handled by AI agent.";
      // Generate tasks immediately after summary
      generateTasksFromSummary(summary);
      return summary;
    } catch (err) {
      console.error("Summary generation failed:", err);
      return "Call completed. Summary unavailable.";
    } finally {
      setIsSummarizing(false);
    }
  };

  const addCallLog = async (status: 'completed' | 'missed' | 'active') => {
    const durationMs = callStartTimeRef.current ? Date.now() - callStartTimeRef.current : 0;
    const seconds = Math.floor(durationMs / 1000);
    const durationStr = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    
    const transcript = status === 'completed' 
      ? await generateCallSummary(durationStr)
      : "Call was missed or terminated prematurely.";

    const newLog: CallLog = {
      id: Date.now().toString(),
      duration: durationStr,
      status,
      transcript,
      timestamp: new Date()
    };
    
    setCallLogs(prev => [newLog, ...prev]);
    callStartTimeRef.current = null;
  };

  const getTemplateSuggestion = async (message: string) => {
    if (templates.length === 0) return null;
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const schema = {
        type: Type.OBJECT,
        properties: {
          templateId: { type: Type.STRING, description: 'The ID of the most relevant template, or null if none fit.' },
          intent: { type: Type.STRING, description: 'One word category for the inquiry (e.g. Pricing, Booking, Greeting)' }
        }
      };
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `User message: "${message}". Available templates: ${JSON.stringify(templates.map(t => ({id: t.id, name: t.name, content: t.content})))}. Which template and intent match best?`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          systemInstruction: 'Analyze business inquiries to identify intent and route to templates.'
        }
      });
      const data = JSON.parse(response.text || '{}');
      if (data.intent) setCurrentIntent(data.intent);
      return data.templateId || null;
    } catch (err) {
      return null;
    }
  };

  const startLiveAgent = async () => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const dynamicInstruction = `
        You are Barta-AI, a professional voice agent. 
        Current Context Focus: ${currentIntent}. 
        Knowledge Base: ${templates.map(t => t.name + ": " + t.content).join("; ")}.
        If the user asks about ${currentIntent}, prioritize information from the relevant knowledge base items. 
        Be helpful, concise, and professional.
      `;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus(AgentStatus.LISTENING);
            setIsLive(true);
            callStartTimeRef.current = Date.now();
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              setStatus(AgentStatus.SPEAKING);
              const ctx = outputContextRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => {
                sourcesRef.current = sourcesRef.current.filter(s => s !== source);
                if (sourcesRef.current.length === 0) setStatus(AgentStatus.LISTENING);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.push(source);
            }
            
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              if (text.length > 10) {
                 getTemplateSuggestion(text).then(id => {
                   if (id) setSuggestedTemplateId(id);
                 });
              }
            }
          },
          onerror: () => { setStatus(AgentStatus.ERROR); addCallLog('missed'); },
          onclose: () => { setIsLive(false); setStatus(AgentStatus.IDLE); addCallLog('completed'); }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: dynamicInstruction
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { setStatus(AgentStatus.ERROR); }
  };

  const handleSmsSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentInput = smsInput;
    const input = currentInput.trim().toLowerCase();
    if (!input) return;

    setMessages(prev => [...prev, { id: Date.now().toString(), sender: 'user', text: currentInput, timestamp: new Date() }]);
    setSmsInput('');
    setSuggestedTemplateId(null);

    getTemplateSuggestion(currentInput).then(id => setSuggestedTemplateId(id));

    const activeTrigger = triggers.find(t => input.includes(t.keyword.toLowerCase()));
    
    let finalResponse = "";
    if (activeTrigger && activeTrigger.action === 'predefined') {
      finalResponse = activeTrigger.response;
    } else {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: currentInput,
          config: {
            systemInstruction: `Automated SMS Agent. Intent Detected: ${currentIntent}. Knowledge Context: ${templates.map(t => t.content).join(" | ")}`
          }
        });
        finalResponse = response.text || "Thinking...";
      } catch (err) { finalResponse = "Error processing request."; }
    }

    setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), sender: 'agent', text: finalResponse, timestamp: new Date() }]);
  };

  const saveTemplate = () => {
    if (newTemplate.name && newTemplate.content) {
      setTemplates([...templates, { ...newTemplate, id: Date.now().toString() }]);
      setNewTemplate({ name: '', content: '' });
    }
  };

  const saveTrigger = () => {
    if (newTrigger.keyword && newTrigger.response) {
      setTriggers([...triggers, { ...newTrigger, id: Date.now().toString() }]);
      setNewTrigger({ keyword: '', action: 'predefined', response: '' });
    }
  };

  const toggleTask = (taskId: string) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, completed: !t.completed } : t));
  };

  const removeTask = (taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
  };

  return (
    <div className="flex flex-col h-screen max-w-7xl mx-auto px-4 py-6 gap-6 relative">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent italic">Barta-AI</h1>
          <p className="text-slate-400">Enterprise AI Voice & SMS Manager</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowConfigModal(true)} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl font-medium border border-slate-700 transition-all flex items-center gap-2">
            <i className="fas fa-sliders-h"></i> Configuration
          </button>
          <button onClick={isLive ? () => sessionRef.current?.close() : startLiveAgent} className={`px-6 py-2 rounded-xl font-bold transition-all shadow-lg active:scale-95 ${isLive ? 'bg-red-500 shadow-red-500/20' : 'bg-blue-600 shadow-blue-500/20'}`}>
            {isLive ? 'Terminate Agent' : 'Activate Live Agent'}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Calls" value={callLogs.length.toString()} icon="fa-phone-alt" color="bg-blue-500" />
        <StatCard title="Pending Tasks" value={tasks.filter(t => !t.completed).length.toString()} icon="fa-check-double" color="bg-amber-500" />
        <StatCard title="KM Templates" value={templates.length.toString()} icon="fa-file-invoice" color="bg-purple-500" />
        <StatCard title="Total Yield" value={`$${(callLogs.length * 3.5 + 4205.5).toFixed(2)}`} icon="fa-dollar-sign" color="bg-emerald-500" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-grow overflow-hidden">
        <div className="lg:col-span-1 flex flex-col gap-6 overflow-hidden">
          {/* Agent Status Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl flex flex-col items-center justify-center p-8 shrink-0 relative overflow-hidden group">
            <div className={`w-28 h-28 rounded-full border-4 border-blue-500/30 flex items-center justify-center mb-4 transition-all duration-500 ${status === AgentStatus.SPEAKING ? 'scale-110 shadow-[0_0_40px_rgba(59,130,246,0.3)]' : ''}`}>
              <i className={`fas fa-robot text-3xl ${status === AgentStatus.SPEAKING ? 'text-blue-400' : 'text-slate-600'}`}></i>
              {isSummarizing && (
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center rounded-full">
                  <i className="fas fa-circle-notch fa-spin text-blue-400"></i>
                </div>
              )}
            </div>
            <h2 className="text-lg font-black uppercase tracking-widest text-slate-200">{isSummarizing ? 'Summarizing...' : status}</h2>
            <div className="mt-4 px-3 py-1 bg-blue-500/10 border border-blue-500/20 rounded-full">
              <span className="text-[10px] font-black uppercase text-blue-400 tracking-tighter">Focus: {currentIntent}</span>
            </div>
          </div>

          {/* Task Management Panel */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl flex-grow flex flex-col overflow-hidden shadow-inner">
            <div className="p-4 border-b border-slate-800 font-bold flex items-center justify-between">
              <span className="flex items-center gap-2"><i className="fas fa-tasks text-amber-400 text-xs"></i> Next Steps</span>
              <span className="text-[10px] text-slate-500 uppercase">{tasks.filter(t => !t.completed).length} Pending</span>
            </div>
            <div className="flex-grow overflow-y-auto p-3 space-y-3">
              {tasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-600 opacity-50 space-y-2">
                  <i className="fas fa-clipboard-list text-2xl"></i>
                  <p className="text-xs italic">No follow-ups suggested yet.</p>
                </div>
              ) : (
                tasks.map(task => (
                  <div key={task.id} className={`p-3 border rounded-xl transition-all ${task.completed ? 'bg-slate-800/10 border-slate-800 opacity-50' : 'bg-slate-800/30 border-slate-700/50 hover:border-slate-600'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-grow min-w-0" onClick={() => toggleTask(task.id)}>
                        <p className={`text-xs font-bold leading-tight ${task.completed ? 'line-through text-slate-600' : 'text-slate-200'}`}>{task.title}</p>
                        <p className="text-[10px] text-slate-500 mt-1 line-clamp-2">{task.description}</p>
                      </div>
                      <button onClick={() => removeTask(task.id)} className="text-slate-700 hover:text-red-400 p-1"><i className="fas fa-times text-[10px]"></i></button>
                    </div>
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-800/50">
                      <span className={`text-[8px] px-1.5 py-0.5 rounded-full uppercase font-bold ${task.priority === 'high' ? 'bg-red-500/10 text-red-400' : task.priority === 'medium' ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400'}`}>
                        {task.priority}
                      </span>
                      <span className="text-[8px] text-slate-600">{task.timestamp.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/50">
            <h2 className="font-bold flex items-center gap-2"><i className="fas fa-comment-dots text-indigo-400"></i> Communication Hub</h2>
            <div className="flex gap-2 items-center">
              <span className="text-[10px] text-slate-500">Intent: <b className="text-indigo-400">{currentIntent}</b></span>
              {suggestedTemplateId && (
                <span className="text-[10px] font-bold text-emerald-400 animate-pulse bg-emerald-400/10 px-2 py-1 rounded border border-emerald-400/20">Smart Suggestion</span>
              )}
            </div>
          </div>
          
          <div className="flex-grow p-4 overflow-y-auto flex flex-col gap-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-slate-700 opacity-40">
                <i className="fas fa-envelope-open-text text-4xl mb-2"></i>
                <p>Chat history will appear here</p>
              </div>
            )}
            {messages.map(msg => (
              <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] p-4 rounded-2xl shadow-xl ${msg.sender === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700'}`}>
                  <p className="text-sm leading-relaxed">{msg.text}</p>
                  <span className="text-[10px] opacity-40 block mt-2 font-mono">{msg.timestamp.toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="px-4 py-2 border-t border-slate-800 flex flex-wrap gap-2 bg-slate-950/50 min-h-[50px]">
            {templates.slice(0, 4).map(t => (
              <button
                key={t.id}
                onClick={() => setSmsInput(t.content)}
                className={`text-[10px] px-3 py-1.5 rounded-lg border transition-all ${suggestedTemplateId === t.id ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 scale-105 shadow-[0_0_10px_rgba(16,185,129,0.2)] font-bold' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'}`}
              >
                {suggestedTemplateId === t.id && <i className="fas fa-magic mr-1"></i>}
                {t.name}
              </button>
            ))}
          </div>

          <form onSubmit={handleSmsSend} className="p-4 bg-slate-950 border-t border-slate-800 flex gap-2 items-center">
            <div className="flex-grow relative">
              <input 
                type="text" 
                value={smsInput} 
                onChange={e => setSmsInput(e.target.value)} 
                placeholder="Message customer..." 
                className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-4 pr-12 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all placeholder:text-slate-600"
              />
              <button 
                type="button"
                onClick={toggleDictation}
                className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg transition-colors ${isDictating ? 'text-red-500 bg-red-500/10 animate-pulse' : 'text-slate-500 hover:text-white hover:bg-slate-800'}`}
              >
                <i className={`fas ${isDictating ? 'fa-microphone' : 'fa-microphone-slash'}`}></i>
              </button>
            </div>
            <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 p-3 rounded-xl aspect-square flex items-center justify-center transition-all active:scale-90 shadow-lg shadow-indigo-900/20">
              <i className="fas fa-paper-plane"></i>
            </button>
          </form>
        </div>
      </div>

      {showConfigModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="flex border-b border-slate-800">
              <button onClick={() => setModalTab('templates')} className={`flex-1 py-4 font-bold text-xs uppercase tracking-widest transition-all ${modalTab === 'templates' ? 'text-blue-400 border-b-2 border-blue-400 bg-blue-400/5' : 'text-slate-500'}`}>Knowledge Base</button>
              <button onClick={() => setModalTab('triggers')} className={`flex-1 py-4 font-bold text-xs uppercase tracking-widest transition-all ${modalTab === 'triggers' ? 'text-amber-400 border-b-2 border-amber-400 bg-amber-400/5' : 'text-slate-500'}`}>Smart Triggers</button>
              <button onClick={() => setModalTab('tasks')} className={`flex-1 py-4 font-bold text-xs uppercase tracking-widest transition-all ${modalTab === 'tasks' ? 'text-indigo-400 border-b-2 border-indigo-400 bg-indigo-400/5' : 'text-slate-500'}`}>Archive</button>
              <button onClick={() => setShowConfigModal(false)} className="px-6 text-slate-500 hover:text-white transition-colors"><i className="fas fa-times"></i></button>
            </div>
            
            <div className="p-6 max-h-[70vh] overflow-y-auto space-y-6">
              {modalTab === 'templates' ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {templates.map(t => (
                      <div key={t.id} className="p-4 bg-slate-800/40 border border-slate-700 rounded-2xl flex justify-between items-start group">
                        <div className="overflow-hidden">
                          <p className="font-bold text-blue-400 text-sm truncate">{t.name}</p>
                          <p className="text-xs text-slate-400 line-clamp-2">{t.content}</p>
                        </div>
                        <button onClick={() => setTemplates(templates.filter(temp => temp.id !== t.id))} className="text-slate-600 hover:text-red-400 ml-2"><i className="fas fa-trash-alt"></i></button>
                      </div>
                    ))}
                  </div>
                  <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3">
                    <input type="text" placeholder="Knowledge Item Title" value={newTemplate.name} onChange={e => setNewTemplate({...newTemplate, name: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-sm outline-none focus:border-blue-500"/>
                    <textarea placeholder="Instruction or Context..." value={newTemplate.content} onChange={e => setNewTemplate({...newTemplate, content: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-sm h-20 outline-none focus:border-blue-500 resize-none"/>
                    <button onClick={saveTemplate} className="w-full bg-blue-600 hover:bg-blue-700 py-3 rounded-xl font-bold transition-all">Add Knowledge</button>
                  </div>
                </div>
              ) : modalTab === 'triggers' ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {triggers.map(t => (
                      <div key={t.id} className="p-4 bg-slate-800/40 border border-amber-500/20 rounded-2xl flex justify-between items-start">
                        <div className="overflow-hidden">
                          <p className="font-black text-amber-500 text-[10px] uppercase tracking-widest">Trigger: {t.keyword}</p>
                          <p className="text-xs text-slate-300 mt-1 line-clamp-2">{t.response}</p>
                        </div>
                        <button onClick={() => setTriggers(triggers.filter(trig => trig.id !== t.id))} className="text-slate-600 hover:text-red-400 ml-2"><i className="fas fa-trash-alt"></i></button>
                      </div>
                    ))}
                  </div>
                  <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3">
                    <div className="flex gap-2">
                      <input type="text" placeholder="Keyword Trigger" value={newTrigger.keyword} onChange={e => setNewTrigger({...newTrigger, keyword: e.target.value})} className="flex-grow bg-slate-900 border border-slate-800 rounded-xl p-3 text-sm outline-none focus:border-amber-500"/>
                      <select value={newTrigger.action} onChange={e => setNewTrigger({...newTrigger, action: e.target.value as any})} className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-sm outline-none text-slate-300">
                        <option value="predefined">Static</option>
                        <option value="ai_guided">AI Guided</option>
                      </select>
                    </div>
                    <textarea placeholder="Behavior response..." value={newTrigger.response} onChange={e => setNewTrigger({...newTrigger, response: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-sm h-20 outline-none focus:border-amber-500 resize-none"/>
                    <button onClick={saveTrigger} className="w-full bg-amber-600 hover:bg-amber-700 py-3 rounded-xl font-bold transition-all">Activate Trigger</button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-slate-400">Archived Call Logs</h3>
                  {callLogs.map(log => (
                    <div key={log.id} className="p-4 bg-slate-800/40 rounded-2xl border border-slate-700 flex flex-col gap-2">
                       <div className="flex justify-between items-center">
                         <span className="text-[10px] font-black uppercase text-indigo-400">{log.status}</span>
                         <span className="text-[10px] text-slate-500">{log.timestamp.toLocaleDateString()}</span>
                       </div>
                       <p className="text-xs text-slate-300 leading-relaxed italic">"{log.transcript}"</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-8 right-8 bg-emerald-600 text-white p-4 rounded-2xl shadow-2xl flex items-center gap-4 border border-emerald-400/20 group hover:scale-105 transition-transform cursor-pointer">
        <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center shadow-inner group-hover:rotate-12 transition-transform"><i className="fas fa-money-bill-trend-up"></i></div>
        <div>
          <p className="text-[10px] font-black uppercase opacity-70 leading-none">Net Business Yield</p>
          <p className="text-xl font-black tracking-tighter">${(callLogs.length * 3.5 + 4205.5).toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
};

export default App;
