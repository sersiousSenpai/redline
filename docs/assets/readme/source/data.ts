import type {ReviewSession, Section, Comment, SessionSummary} from '../../../../src/types';
export const now=Date.now();
const blocks=[
 ['# Durable background jobs','Durable background jobs'],
 ['Keep long-running work resumable, observable, and safe to retry.','Keep long-running work resumable, observable, and safe to retry.'],
 ['## Persist before dispatch','Persist before dispatch'],
 ['Write the job and its initial state in a durable transaction. Return its ID only after the transaction commits.','Write the job and its initial state in a durable transaction. Return its ID only after the transaction commits.'],
 ['## Make retries explicit','Make retries explicit'],
 ['A retry must reuse the original idempotency key. Read the recorded outcome before repeating a side effect.','A retry must reuse the original idempotency key. Read the recorded outcome before repeating a side effect.'],
 ['1. Claim the next ready job with a lease.\n2. Record a checkpoint before continuing.\n3. Retry transient failures with bounded backoff.','Claim the next ready job with a lease. Record a checkpoint before continuing. Retry transient failures with bounded backoff.'],
 ['## Verify recovery','Verify recovery'],
 ['Stop a worker between dispatch and acknowledgement. Restart it and confirm that the job resumes without repeating a completed side effect.','Stop a worker between dispatch and acknowledgement. Restart it and confirm that the job resumes without repeating a completed side effect.'],
];
export const markdown=blocks.map(([md],i)=>`<!-- rl:blk-readme${i.toString().padStart(4,'0')} -->\n${md}`).join('\n\n');
export const sections:Section[]=[];let section:Section;
blocks.forEach(([md,text],i)=>{const blockId=`blk-readme${i.toString().padStart(4,'0')}`;const anchorId=`sec-${i}`;if(md.startsWith('#')){section={anchorId,blockId,level:md.startsWith('##')?2:1,title:text,bodyMarkdown:'',children:[],paragraphs:[]};sections.push(section)}else{section.paragraphs.push({anchorId:`${section.anchorId}:p${section.paragraphs.length}`,blockId,markdown:md,text});section.bodyMarkdown+=md+'\n\n'}});
export const comments:Comment[]=[
 {id:'c-001',type:'question',anchorId:'sec-4:p0',blockId:'blk-readme0005',body:'What if a worker finishes the job but loses the acknowledgement?',createdAt:now-60000,status:'resolved',resolution:{body:'The retry reads the stored outcome using the **same idempotency key**. A completed job returns its saved result; the side effect is not repeated.\n\nAdded this recovery case to **v3**.',appearedInVersion:3,acceptedAt:null},selection:{charStart:0,charEnd:46,quotedText:'A retry must reuse the original idempotency key.'}},
 {id:'c-002',type:'feedback',anchorId:'sec-7:p0',blockId:'blk-readme0008',body:'Add a recovery test for a worker that loses its lease mid-job.',createdAt:now-30000,status:'draft'},
];
export const session:ReviewSession={sessionId:'readme-terminal-plan',projectPath:'/sample',projectName:'',createdAt:now-600000,status:'in_review',attachState:'held',backend:'claude-code',model:'opus',effort:'high',revisions:[1,2,3].map(versionNumber=>({versionNumber,receivedAt:now-(3-versionNumber)*180000,rawPlanMarkdown:markdown,sections,comments:versionNumber===3?comments:[],threadStart:versionNumber===1,restored:false}))};
export const summaries:SessionSummary[]=[{sessionId:session.sessionId,projectName:'',projectPath:session.projectPath,planTitle:'Durable background jobs',latestVersion:3,revisions:session.revisions.map(({versionNumber,receivedAt,threadStart,restored})=>({versionNumber,receivedAt,threadStart,restored})),createdAt:session.createdAt,updatedAt:now,status:'in_review',pendingCount:1,awaitingReview:true,held:true,heldTerminalId:'readme-terminal',attachState:'held',backend:'claude-code',model:'opus',effort:'high'},...['Search architecture','Workspace onboarding'].map((planTitle,i)=>({sessionId:`readme-other-${i}`,projectName:'',projectPath:'/sample',planTitle,latestVersion:1,revisions:[{versionNumber:1,receivedAt:now-3600000*(i+1),threadStart:true,restored:false}],createdAt:now-3600000*(i+1),updatedAt:now-3600000*(i+1),status:'approved' as const,pendingCount:0,awaitingReview:false,held:false,attachState:'idle' as const,backend:'claude-code'}))];
