"""Coordinator missions delegate persisted specialist missions and hand off results."""
import json
from pydantic import BaseModel, Field
from spur.missions import structured
from spur.agent import generate_report


class Assignment(BaseModel):
    agent_id: str
    instruction: str = Field(min_length=1,max_length=3000)


class TeamPlan(BaseModel):
    objective: str = Field(min_length=1,max_length=1500)
    strategy: str = Field(default='',max_length=2500)
    success_criteria: list[str] = Field(default_factory=list,max_length=8)
    assignments: list[Assignment] = Field(min_length=1,max_length=12)


async def team_step(store,settings,job,client):
    mission=store.mission(job['payload']['mission_id']);state=mission['state']
    emit=lambda kind,title,details=None:store.record_event(job,kind,title,details)
    checkpoint=lambda message,**kwargs:store.checkpoint_mission(job,state,message,**kwargs)
    if state['phase']=='team_plan':
        agents=[a for a in store.agents() if a['id']!='coordinator']
        from spur.social import SocialStore,analytics_brief
        from spur.library import Library
        social=SocialStore(store)
        from spur.mock_profiles import context as mock_context,MODEL_BOUNDARY
        from spur.profile_analytics import model_context
        own_analytics=[analytics_brief(snapshot) for platform in ('youtube','instagram','tiktok')
                      if (snapshot:=social.latest(platform,28)) is not None]
        emit('model','Marketing Lead is planning the campaign and assigning specialists',{'available_agents':[a['name'] for a in agents]})
        plan=await structured(client,settings,
            'Act as the marketing lead. Plan a coordinated creator campaign. Return JSON with objective, strategy, '
            'success_criteria (proposed measures, never invented measured results), and 1-12 assignments. '
            'Use only the agents needed for the goal; you may use every registered specialist when requested. '
            'Each assignment needs a registered agent_id and clear instruction. Tasks run IN ORDER and later '
            'tasks receive earlier results. Use Channel Scout for discovery, Competitor Analyst for comparison. '
            'Do not assign duplicate discovery tasks or multiply the requested channel target across assignments. '
            'Choose registered creator specialists for ideas, scripts, titles/hooks, thumbnail briefs, short-form scripts, '
            'SEO metadata, dated calendars, and unsent sponsorship pitches. Creative agents can work without collected videos. '
            'Prefer existing supplied material to redundant discovery. A task must produce the requested deliverable, '
            'not merely advice. Available tools also include channel discovery, watchlist actions, feed collection and metadata research. '
            'Use supplied connected-account analytics when available; never invent private competitor metrics. '
            'Do not claim access to transcripts or video viewing. Do not issue destructive '
            'actions unless explicitly requested. The coordinator cannot delegate to itself.'+MODEL_BOUNDARY,
            {'request':mission['prompt'],'lead_instructions':state.get('agent_instructions',''),
             'creator_brief':store.get_runtime('creator_brief',{}),'supplied_output':state.get('input_report'),
             'connected_account_analytics':own_analytics,
             'mock_creator_profile':mock_context(store),'computed_profile_analytics':model_context(store,limit=5),
             'content_library':Library(store).context(mission['prompt']),
             'specialists':agents},TeamPlan)
        if any(t.agent_id not in {a['id'] for a in agents} for t in plan.assignments):
            raise ValueError('Coordinator selected an unregistered specialist')
        state['team_plan']=plan.model_dump();state['model_calls']+=1;state['phase']='team_work'
        emit('plan','Team assignments ready',{'objective':plan.objective,'assignments':[f'{t.agent_id}: {t.instruction}' for t in plan.assignments]})
        checkpoint('Team plan ready. Delegating specialist work.')
        return
    if state['phase']=='team_work':
        assignments=state['team_plan']['assignments'];children=state['children']
        if children:
            current=store.mission(children[-1])
            if current['status'] in ('active','paused'):
                checkpoint('Waiting for '+current['state'].get('agent_name','specialist')+' to finish its assignment.',delay=10)
                return
            if current['status'] not in ('completed','partial'):
                state['phase']='team_failed'
                checkpoint('A specialist assignment failed or was cancelled. Review the child mission before starting a new team run.',terminal='failed')
                return
        if len(children)<len(assignments):
            index=len(children);assignment=assignments[index]
            handoff=[]
            for child_id in children:
                child=store.mission(child_id);report_id=child['state'].get('report_id')
                handoff.append({'agent':child['state'].get('agent_name'),'status':child['status'],
                                'channels_followed':len(child['state']['channels']),
                                'summary':store.reports(report_id)['content']['summary'] if report_id else 'No report produced',
                                'deliverable':store.reports(report_id)['content'].get('artifact') if report_id else None,
                                'shortfall':child['state'].get('shortfall')})
            prompt=assignment['instruction']+'\n\nOriginal team goal: '+mission['prompt']
            prompt+='\n\nMarketing strategy: '+state['team_plan'].get('strategy','')
            if state.get('input_report'):prompt+='\n\nSupplied source output: '+json.dumps(state['input_report'],ensure_ascii=False)
            if handoff:prompt+='\n\nPrevious specialist results (context; verify current claims): '+json.dumps(handoff,ensure_ascii=False)
            child_id=store.delegate_mission(mission['id'],index,assignment['agent_id'],prompt[:18000],state['days'])
            if not child_id:
                store.finish(job,{'skipped':'Coordinator stopped before delegation'});return
            state['children']=store.mission(mission['id'])['state']['children']
            emit('handoff','Assignment sent to specialist',{'agent':store.agent(assignment['agent_id'])['name'],
                 'instruction':assignment['instruction'],'child_mission_id':child_id,'prior_results':handoff})
            checkpoint('Delegated assignment '+str(index+1)+'/'+str(len(assignments))+'.',delay=10)
            return
        state['phase']='team_report'
        checkpoint('Specialist assignments finished. Synthesizing their findings.')
        return
    if state['phase']=='team_report':
        handoff=[];channel_ids=[];partial=False;child_outputs=[]
        for child_id in state['children']:
            child=store.mission(child_id);s=child['state'];partial |= child['status']=='partial'
            channel_ids.extend(c['channel_id'] for c in s['channels'])
            if s.get('report_id'):
                r=store.reports(s['report_id'])['content']
                handoff.append({'agent':s.get('agent_name'),'summary':r['summary'],'deliverable':r.get('artifact'),'limitations':r['limitations']})
                child_outputs.append({'agent':s.get('agent_name'),'report_id':s['report_id'],'content':r})
        state['channels']=[{'channel_id':i} for i in dict.fromkeys(channel_ids)]
        if child_outputs and all(o['content'].get('artifact') for o in child_outputs):
            # Creative packages do not need fabricated research claims or fresh video
            # evidence. Preserve the concrete specialist outputs as the final result.
            assumptions=list(dict.fromkeys(a for o in child_outputs for a in o['content'].get('assumptions',[])))
            verification=list(dict.fromkeys(a for o in child_outputs for a in o['content'].get('verification_needed',[])))
            report={'topic':mission['prompt'],'title':'Creator package: '+state['team_plan']['objective'][:150],
                    'summary':f"Completed {len(child_outputs)} specialist deliverables in sequence: "+', '.join(o['agent'] for o in child_outputs)+'. Each agent received the previous output. Review the drafts and verification tasks before production.',
                    'artifact':{'kind':'creator_package','data':{'goal':mission['prompt'],
                        'strategy':state['team_plan'].get('strategy',''),
                        'success_criteria':state['team_plan'].get('success_criteria',[]),
                        'execution_plan':state['team_plan']['assignments'],'deliverables':[
                        {'agent':o['agent'],'title':o['content'].get('title',o['agent']),
                         'deliverable':o['content']['artifact']['data']} for o in child_outputs]}},
                    'model':settings.model,'provider':settings.provider,'mission_id':mission['id'],'agent_id':'coordinator',
                    'assumptions':assumptions,'verification_needed':verification,
                    'limitations':['Creative drafts only. No content published, messages sent, or media rendered.'],
                    'sources':{},'developments':[],'potential_trends':[],
                    'team_assignments':state['children'],'team_outputs':[{'agent':o['agent'],'report_id':o['report_id']} for o in child_outputs]}
            state['phase']='done'
            emit('result','Creator package assembled',{'deliverables':len(child_outputs)})
            checkpoint('Team creator package saved with all specialist deliverables.',terminal='partial' if partial else 'completed',report=report)
            return
        report=await generate_report(store,settings,{'topic':mission['prompt'],'days':state['days'],
            'channel_ids':list(dict.fromkeys(channel_ids)),
            'mission_context':{'team_plan':state['team_plan'],'specialist_findings':handoff}},client,progress=emit)
        report['mission_id']=mission['id'];report['agent_id']='coordinator';report['team_assignments']=state['children']
        report['team_outputs']=[{'agent':store.mission(cid)['state'].get('agent_name'),
            'report_id':store.mission(cid)['state'].get('report_id')} for cid in state['children']]
        state['phase']='done'
        checkpoint('Team report saved. Specialist findings and source evidence have been combined.',terminal='partial' if partial else 'completed',report=report)
        return
    raise ValueError('Team mission cannot continue from this phase; inspect specialist failures.')
