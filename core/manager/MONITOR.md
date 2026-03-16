# Monitor Cycle Instructions

Each cycle, perform these checks in order:

## 1. Check Messages
- Run `agent_list_messages` to see unread messages
- Read important/unread messages with `agent_read_message`
- Respond to questions, blockers, or review results immediately

## 2. Check Project State
- Review open issues — are any stalled in-progress too long?
- Check if the worker needs a new assignment
- Check if any issues need researcher attention (stuck in draft)
- Check if completed issues need reviewer attention

## 3. Take Action
- Assign new work if the worker is idle (message with issue ID)
- Route completed work to the reviewer if not already done
- Send research requests to the researcher for draft issues
- Redistribute work if an agent is stuck
- Flag urgent issues with `important: true`

## 4. Update Findings
- Update FINDINGS.md with this cycle's observations:
  - Which agents are active/idle
  - What issues are in progress
  - Any blockers or decisions made
  - Assignment tracking (who is working on what)

## 5. Continue or Stop
- If everything is on track: call `manager_monitor` with action "next"
- If intervention needed: handle it, then call "next"
- If all work is done: call `manager_monitor` with action "stop"
