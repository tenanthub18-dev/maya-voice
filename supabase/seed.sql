-- Deterministic local demo data aligned with apps/web/lib/data/mock/seed.ts.
insert into public.organizations(id,name,plan,spend_cap_cents)
values('01000000-0000-4000-8000-000000000001','Harbour Table Group','growth',20000)
on conflict(id) do nothing;

insert into public.restaurants(id,organization_id,name,address,province,timezone,primary_language,enabled_languages,transfer_phone,transfer_hours,status)
values('02000000-0000-4000-8000-000000000002','01000000-0000-4000-8000-000000000001','Harbour Table','88 Queens Quay W, Toronto, ON','ON','America/Toronto','en',array['en','fr-CA','ur','hi','pa'],'+14165550100','{"start":"09:00","end":"22:00"}','live')
on conflict(id) do nothing;

insert into public.hours(id,restaurant_id,weekday,open_time,close_time)
select ('03000000-0000-4000-8000-' || lpad(day::text,12,'0'))::uuid,'02000000-0000-4000-8000-000000000002',day,'11:00','22:00'
from generate_series(0,6) day on conflict(restaurant_id,weekday) do nothing;
insert into public.hours_overrides(id,restaurant_id,date,open_time,close_time)
values('04000000-0000-4000-8000-000000000004','02000000-0000-4000-8000-000000000002','2026-12-25',null,null)
on conflict(restaurant_id,date) do nothing;

insert into public.menu_items(id,restaurant_id,name,description,price_cents,category,dietary_tags,available) values
('05000000-0000-4000-8000-000000000005','02000000-0000-4000-8000-000000000002','Butter chicken','Tomato and cream curry',2195,'Mains',array['halal'],true),
('05000000-0000-4000-8000-000000000006','02000000-0000-4000-8000-000000000002','Chana masala','Chickpea curry',1695,'Mains',array['vegan','gluten-free'],true)
on conflict(id) do nothing;
insert into public.menu_modifiers(id,menu_item_id,name,price_delta_cents,required,max_select) values
('06000000-0000-4000-8000-000000000006','05000000-0000-4000-8000-000000000005','Extra naan',350,false,3)
on conflict(id) do nothing;
insert into public.faqs(id,restaurant_id,question,answer,language,source) values
('07000000-0000-4000-8000-000000000007','02000000-0000-4000-8000-000000000002','Do you have halal options?','All chicken dishes are halal.','en','owner')
on conflict(id) do nothing;

insert into public.agents(id,restaurant_id,persona_name,filler_level,enabled)
values('08000000-0000-4000-8000-000000000008','02000000-0000-4000-8000-000000000002','Asha','natural',true)
on conflict(id) do nothing;
insert into public.agent_versions(id,agent_id,version_no,status,prompt_sections,voices,rules,published_at) values
('09000000-0000-4000-8000-000000000009','08000000-0000-4000-8000-000000000008',1,'published','{"greeting":"Welcome to Harbour Table"}','{}','{"takeout":true}','2026-10-01T12:00:00Z'),
('09000000-0000-4000-8000-000000000010','08000000-0000-4000-8000-000000000008',2,'draft','{"greeting":"Welcome"}','{}','{"takeout":true}',null)
on conflict(id) do nothing;
update public.agents set current_published_version_id='09000000-0000-4000-8000-000000000009' where id='08000000-0000-4000-8000-000000000008';
insert into public.phone_numbers(id,restaurant_id,e164,telnyx_number_id,status,forwarding_verified_at)
values('10000000-0000-4000-8000-000000000010','02000000-0000-4000-8000-000000000002','+14165550100','demo-number-1','active','2026-10-01T12:00:00Z')
on conflict(id) do nothing;
insert into public.slots_config(id,restaurant_id,slot_minutes,covers_per_slot,seating_minutes,max_party,lead_time_minutes,booking_window_days)
values('11000000-0000-4000-8000-000000000011','02000000-0000-4000-8000-000000000002',15,16,90,8,60,90)
on conflict(restaurant_id) do nothing;

insert into public.calls(id,restaurant_id,agent_version_id,telnyx_call_id,from_e164_hash,from_last4,started_at,ended_at,billable_seconds,outcome,languages,transferred,summary,qa_flags,cost_micros)
select md5('demo-call-'||n)::uuid,'02000000-0000-4000-8000-000000000002','09000000-0000-4000-8000-000000000009','demo-call-'||n,
  encode(sha256(('demo-caller-'||n)::bytea),'hex'),lpad((4100+n)::text,4,'0'),
  '2026-10-14T16:00:00Z'::timestamptz + n*interval '7 hours', '2026-10-14T16:00:00Z'::timestamptz + n*interval '7 hours' + (60+n)*interval '1 second',
  60+n,(array['booking','order','message','answered','transferred'])[(n%5)+1],
  array[(array['en','fr-CA','ur','hi','pa'])[(n%5)+1]],(n%5)=4,'Demo call '||n,
  case when n%13=0 then array['review'] else '{}'::text[] end,jsonb_build_object('stt',5200+n,'llm',2600+n,'tts',7100+n)
from generate_series(1,40) n on conflict(telnyx_call_id) do nothing;

insert into public.call_turns(call_id,idx,speaker,language,text,started_ms,ended_ms,interrupted)
select id,0,'caller',languages[1],'Demo caller request',0,1200,false from public.calls where telnyx_call_id like 'demo-call-%'
on conflict(call_id,idx) do nothing;
insert into public.call_metrics(call_id,turn_idx,eot_ms,stt_ms,llm_ttft_ms,tts_ttfb_ms,total_ms)
select id,0,105,145,195,155,650 from public.calls where telnyx_call_id like 'demo-call-%'
on conflict(call_id,turn_idx) do nothing;

insert into public.bookings(id,restaurant_id,call_id,name,phone_e164,party_size,starts_at,status,notes,source)
select md5('booking-'||row_number() over(order by id))::uuid,restaurant_id,id,'Guest '||row_number() over(order by id),'+14165550200',4,
  '2026-11-10T22:30:00Z'::timestamptz + row_number() over(order by id)*interval '1 day','confirmed','','phone'
from public.calls where telnyx_call_id like 'demo-call-%' and outcome='booking' on conflict(id) do nothing;
insert into public.orders(id,restaurant_id,call_id,name,phone,pickup_at,subtotal_cents,tax_cents,total_cents,paid_status,status)
select md5('order-'||row_number() over(order by id))::uuid,restaurant_id,id,'Pickup '||row_number() over(order by id),'+14165550300',
  '2026-10-28T22:30:00Z'::timestamptz + row_number() over(order by id)*interval '1 hour',2195,285,2480,'unpaid','new'
from public.calls where telnyx_call_id like 'demo-call-%' and outcome='order' on conflict(id) do nothing;
insert into public.order_items(order_id,item,modifiers,modifier_price_cents,quantity,price_cents)
select id,'Butter chicken','{}','{}',1,subtotal_cents from public.orders on conflict do nothing;
insert into public.messages(id,restaurant_id,call_id,caller_name,phone,text,handled)
select md5('message-'||row_number() over(order by id))::uuid,restaurant_id,id,'Caller '||row_number() over(order by id),'+14165550400','Please call me back.',false
from public.calls where telnyx_call_id like 'demo-call-%' and outcome='message' on conflict(id) do nothing;
insert into public.usage_ledger(id,organization_id,period,seconds,stripe_reported,cost_micros)
select '12000000-0000-4000-8000-000000000012','01000000-0000-4000-8000-000000000001','2026-10',sum(billable_seconds),false,
  sum(((cost_micros->>'stt')::bigint)+((cost_micros->>'llm')::bigint)+((cost_micros->>'tts')::bigint))
from public.calls where restaurant_id='02000000-0000-4000-8000-000000000002'
on conflict(organization_id,period) do nothing;
