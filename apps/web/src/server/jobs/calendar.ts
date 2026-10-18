import { addCivilDays, calendarContext, frozenClock, instant, localDate, localDateTime,
  resolveCalendar, timeZone, type Instant } from '@everyfield/contracts/common';

function automatic(wall:string,zone:string):Instant {
  const resolved=resolveCalendar(localDateTime.parse(wall),timeZone.parse(zone),'automatic');
  if(resolved.kind!=='resolved')throw Error('calendar_unresolved');return resolved.occurrence.instant;
}
export function taskReminderTimes(due:{kind:'undated'}|{kind:'date_only';date:string;zone:string}|{kind:'timed';at:string}) {
  if(due.kind==='undated')return [];
  if(due.kind==='timed'){
    const at=instant.parse(due.at);return [{slot:'due' as const,at},{slot:'overdue' as const,at:instant.parse(new Date(Date.parse(at)+86_400_000).toISOString())}];
  }
  const date=localDate.parse(due.date);
  return [{slot:'due' as const,at:automatic(`${date}T09:00:00`,due.zone)},
    {slot:'overdue' as const,at:automatic(`${addCivilDays(date,1)}T09:00:00`,due.zone)}];
}
export function meetingReminderTimes(date:string,time:string,zone:string) {
  const day=localDate.parse(date);
  return [7,3,1].map(offset=>({slot:`day_${offset}`,at:automatic(`${addCivilDays(day,-offset)}T${time}`,zone)}));
}
export function owedPeriod(config:{zone:string;cadence:'daily'|'weekly';weekday:number;hour:number;completedDaysOnly?:boolean},asOf:string,coveredThrough:string|null) {
  const now=instant.parse(asOf),zone=timeZone.parse(config.zone);
  const today=calendarContext(zone,frozenClock(now)).localDate;
  let end=today;
  if(automatic(`${end}T${String(config.hour).padStart(2,'0')}:00:00`,zone)>now)end=addCivilDays(end,-1);
  if(config.cadence==='weekly'){
    const weekday=new Date(`${end}T00:00:00Z`).getUTCDay();end=addCivilDays(end,-((weekday-config.weekday+7)%7));
  }
  if(config.completedDaysOnly)end=addCivilDays(end,-1);
  const start=coveredThrough?addCivilDays(localDate.parse(coveredThrough),1):addCivilDays(end,config.cadence==='weekly'?-6:0);
  if(start>end)return null;
  return {start,end,next:addCivilDays(end,config.cadence==='weekly'?7:1),zone};
}
