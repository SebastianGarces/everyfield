import test from 'node:test';
import assert from 'node:assert/strict';
import {taskReminderTimes,meetingReminderTimes,owedPeriod} from '../../../apps/web/src/server/jobs/calendar.ts';
test('INV-calendar: reminders use civil offsets and timed overdue uses elapsed hours',()=>{
 assert.deepEqual(taskReminderTimes({kind:'date_only',date:'2026-03-08',zone:'America/Chicago'}),[
  {slot:'due',at:'2026-03-08T14:00:00.000Z'},{slot:'overdue',at:'2026-03-09T14:00:00.000Z'}]);
 assert.deepEqual(taskReminderTimes({kind:'date_only',date:'2026-11-01',zone:'America/Chicago'}),[
  {slot:'due',at:'2026-11-01T15:00:00.000Z'},{slot:'overdue',at:'2026-11-02T15:00:00.000Z'}]);
 assert.deepEqual(taskReminderTimes({kind:'timed',at:'2026-03-08T07:30:00Z'}),[
  {slot:'due',at:'2026-03-08T07:30:00.000Z'},{slot:'overdue',at:'2026-03-09T07:30:00.000Z'}]);
 assert.deepEqual(meetingReminderTimes('2026-03-09','09:00:00','America/Chicago'),[
  {slot:'day_7',at:'2026-03-02T15:00:00.000Z'},{slot:'day_3',at:'2026-03-06T15:00:00.000Z'},{slot:'day_1',at:'2026-03-08T14:00:00.000Z'}]);
 assert.deepEqual(taskReminderTimes({kind:'undated'}),[]);
});
test('INV-digest: missed dates form one owed interval under the confirmed zone and default Sunday schedule',()=>{
 assert.deepEqual(owedPeriod({zone:'America/Chicago',cadence:'weekly',weekday:0,hour:16},'2026-10-18T22:00:00Z','2026-09-27'),
  {start:'2026-09-28',end:'2026-10-18',next:'2026-10-25',zone:'America/Chicago'});
 assert.equal(owedPeriod({zone:'America/Chicago',cadence:'weekly',weekday:0,hour:16},'2026-10-18T20:00:00Z','2026-10-11'),null);
});
