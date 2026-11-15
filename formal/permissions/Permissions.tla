----------------------------- MODULE Permissions -----------------------------
(***************************************************************************)
(* Everyfield's workspace permissions: seats, sessions, invitations and    *)
(* the tenant statements that resolve an actor first and run later.        *)
(*                                                                         *)
(* Each action and property names the code it models in                    *)
(* .agents/skills/formal-permissions/map.json. Keep the two in step with   *)
(* .agents/skills/maintain-formal-verification/SKILL.md.                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Owners,       \* the founding owner of each workspace: Workspaces -> Accounts
    Others,       \* accounts other than the founding owners
    Start,        \* each other account's first seat: <<workspace, role>>, or "none"
    Workspaces,
    Invitations,  \* invitation slots
    Requests,     \* request slots for tenant statements
    MaxSeats,     \* seats an account may hold over the run (one live at a time)
    MaxSessions,  \* sessions an account may sign in over the run
    MaxRevision   \* bound on a seat's revision, to keep the state space finite

Accounts == {Owners[w] : w \in Workspaces} \cup Others
None == "none"
Roles == {"owner", "admin", "member"}
Administrators == {"owner", "admin"}
InvitableRoles == {"admin", "member"}

\* A seat action and the role it sets ("none" for a removal).
SeatChanges == {<<"appointAdmin", "admin">>, <<"demote", "member">>,
                <<"changeOrdinaryRole", "admin">>, <<"changeOrdinaryRole", "member">>,
                <<"remove", None>>}
SeatOps == {c[1] : c \in SeatChanges}
\* A tenant statement: any seat may read; only an Owner or Admin reads the
\* administrators' lists; a write carries the resolved seat's revision (D70).
\* The writes that check access in their final statement (writeAuthority) are
\* People's single-statement writes, and only an Owner or Admin makes them.
StatementKinds == {"read", "adminRead", "write"}
InvitationStates == {"pending", "accepted", "revoked", "expired"}

SeatIds == Accounts \X (1..MaxSeats)
SessionIds == Accounts \X (1..MaxSessions)

VARIABLES
    seats,        \* SeatIds -> [state, ws, role, rev, inv]
    sessions,     \* SessionIds -> "unused" | "live" | "ended"
    invitations,  \* Invitations -> [state, ws, role, to]
    requests,     \* Requests -> the actor a request resolved, or idle
    data,         \* Workspaces -> 0..1, flipped by each tenant write
    last          \* the step just taken, as its audit row would name it

vars == <<seats, sessions, invitations, requests, data, last>>
\* No action reads `last` or `data`; they only record the step for the action
\* properties. TLC fingerprints states by this view, so they add no states.
View == <<seats, sessions, invitations, requests>>

-----------------------------------------------------------------------------
(* The permission rules. The actions below and the outcome table the      *)
(* conformance test reads both use these operators, so neither keeps a    *)
(* second copy.                                                            *)

\* seats.ts mutation: an Owner or Admin changes an ordinary seat; the Owner
\* seat is protected (protected_owner); demote needs an Admin target.
MayChangeSeat(op, actorRole, targetRole, to) ==
    /\ actorRole \in Administrators
    /\ targetRole # "owner"
    /\ \/ op = "appointAdmin" /\ to = "admin"
       \/ op = "demote" /\ targetRole = "admin" /\ to = "member"
       \/ op = "changeOrdinaryRole" /\ to \in InvitableRoles
       \/ op = "remove" /\ to = None

\* invitations.ts invite: an Owner or Admin invites an ordinary role.
MayInvite(inviterRole, role) == inviterRole \in Administrators /\ role \in InvitableRoles

\* invitations.ts change (revoke): an Owner or Admin of the invitation's workspace.
MayRevoke(actorRole) == actorRole \in Administrators

\* invitations.ts accept: a pending, unexpired invitation, by an account with no live seat.
MayAccept(state, seated) == state = "pending" /\ ~seated

\* Resolving the request actor (RequestActor.resolve, then the operation's own
\* role check on that resolved actor: an administrators' list or a write needs
\* an Owner or Admin).
ResolveAdmits(kind, role) == kind \in {"adminRead", "write"} => role \in Administrators

\* session.ts liveRead / writeAuthority: the check inside the statement itself,
\* against the seat and session as they are when the statement runs (C13, D70).
LiveCheck(q, cur, session) ==
    /\ session = "live"
    /\ cur.state = "live"
    /\ cur.ws = q.ws
    /\ (q.kind = "adminRead" => cur.role \in Administrators)
    /\ (q.kind = "write" => cur.role = q.role /\ cur.rev = q.rev)

ReadAdmits(q, cur, session) == LiveCheck(q, cur, session)
WriteAdmits(q, cur, session) == LiveCheck(q, cur, session)
Admits(q, cur, session) ==
    IF q.kind = "write" THEN WriteAdmits(q, cur, session) ELSE ReadAdmits(q, cur, session)

-----------------------------------------------------------------------------
LiveSeats(a) == {s \in SeatIds : s[1] = a /\ seats[s].state = "live"}
LiveSeatIn(a, w) == {s \in LiveSeats(a) : seats[s].ws = w}
Seated(a) == LiveSeats(a) # {}
NextFree(a) == CHOOSE k \in 1..MaxSeats :
                   /\ seats[<<a, k>>].state = "unused"
                   /\ \A j \in 1..(k - 1) : seats[<<a, j>>].state # "unused"
NoSeat == [state |-> "unused", ws |-> None, role |-> None, rev |-> 0, inv |-> None]
Idle == [state |-> "idle", session |-> None, ws |-> None, kind |-> None,
         seat |-> None, role |-> None, rev |-> 0]
Step(op, session, target, ok) == [op |-> op, session |-> session, target |-> target, ok |-> ok]

\* Each workspace starts with its owner; every other account starts as Start says.
Init ==
    /\ LET start == Start IN
          seats = [s \in SeatIds |->
                     IF s[2] # 1 THEN NoSeat
                     ELSE IF \E w \in Workspaces : Owners[w] = s[1]
                          THEN [state |-> "live", ws |-> CHOOSE w \in Workspaces : Owners[w] = s[1],
                                role |-> "owner", rev |-> 1, inv |-> None]
                     ELSE IF start[s[1]] = None THEN NoSeat
                     ELSE [state |-> "live", ws |-> start[s[1]][1], role |-> start[s[1]][2],
                           rev |-> 1, inv |-> None]]
    /\ sessions = [s \in SessionIds |-> IF s[2] = 1 THEN "live" ELSE "unused"]
    /\ invitations = [i \in Invitations |-> [state |-> "unused", ws |-> None, role |-> None, to |-> None]]
    /\ requests = [r \in Requests |-> Idle]
    /\ data = [w \in Workspaces |-> 0]
    /\ last = Step("init", None, None, TRUE)

-----------------------------------------------------------------------------
(* Sessions *)

\* Owners keep their first session (it may still end); the other accounts sign in again.
SignIn(s) ==
    /\ s[1] \in Others
    /\ sessions[s] = "unused"
    /\ \A k \in 1..(s[2] - 1) : sessions[<<s[1], k>>] # "unused"
    /\ sessions' = [sessions EXCEPT ![s] = "live"]
    /\ last' = Step("signIn", s, None, TRUE)
    /\ UNCHANGED <<seats, invitations, requests, data>>

EndSession(s) ==
    /\ sessions[s] = "live"
    /\ sessions' = [sessions EXCEPT ![s] = "ended"]
    /\ last' = Step("endSession", s, None, TRUE)
    /\ UNCHANGED <<seats, invitations, requests, data>>

(* Seat actions: writeAsAdministrator binds the actor under its locks, then *)
(* the command checks the target seat (seats.ts mutation).                 *)
SeatAction(s, op, to, t) ==
    LET a == s[1]
        target == seats[t]
    IN
    /\ sessions[s] = "live"
    /\ target.state = "live"
    /\ target.rev < MaxRevision
    /\ \E mine \in LiveSeatIn(a, target.ws) : MayChangeSeat(op, seats[mine].role, target.role, to)
    /\ seats' = [seats EXCEPT ![t] =
                   IF op = "remove" THEN [target EXCEPT !.state = "ended", !.rev = @ + 1]
                   ELSE IF to = target.role THEN target
                   ELSE [target EXCEPT !.role = to, !.rev = @ + 1]]
    \* A removal ends every session of the removed account (revoke_removed_seat_sessions).
    /\ sessions' = IF op = "remove"
                   THEN [x \in SessionIds |-> IF x[1] = t[1] /\ sessions[x] = "live" THEN "ended" ELSE sessions[x]]
                   ELSE sessions
    /\ last' = Step(op, s, t, TRUE)
    /\ UNCHANGED <<invitations, requests, data>>

(* Invitations *)

Invite(s, i, w, role, to) ==
    /\ sessions[s] = "live"
    /\ invitations[i].state = "unused"
    /\ \E mine \in LiveSeatIn(s[1], w) : MayInvite(seats[mine].role, role)
    /\ invitations' = [invitations EXCEPT ![i] = [state |-> "pending", ws |-> w, role |-> role, to |-> to]]
    /\ last' = Step("invite", s, i, TRUE)
    /\ UNCHANGED <<seats, sessions, requests, data>>

Revoke(s, i) ==
    /\ sessions[s] = "live"
    /\ invitations[i].state = "pending"
    /\ \E mine \in LiveSeatIn(s[1], invitations[i].ws) : MayRevoke(seats[mine].role)
    /\ invitations' = [invitations EXCEPT ![i].state = "revoked"]
    /\ last' = Step("revoke", s, i, TRUE)
    /\ UNCHANGED <<seats, sessions, requests, data>>

\* 30 elapsed days pass: d.current refuses the invitation from then on.
Expire(i) ==
    /\ invitations[i].state = "pending"
    /\ invitations' = [invitations EXCEPT ![i].state = "expired"]
    /\ last' = Step("expire", None, i, TRUE)
    /\ UNCHANGED <<seats, sessions, requests, data>>

Accept(s, i) ==
    LET a == s[1]
        inv == invitations[i]
    IN
    /\ sessions[s] = "live"
    /\ inv.state # "unused"
    /\ inv.to = a
    /\ MayAccept(inv.state, Seated(a))
    /\ \E k \in 1..MaxSeats : seats[<<a, k>>].state = "unused"
    /\ seats' = [seats EXCEPT ![<<a, NextFree(a)>>] =
                   [state |-> "live", ws |-> inv.ws, role |-> inv.role, rev |-> 1, inv |-> i]]
    /\ invitations' = [invitations EXCEPT ![i].state = "accepted"]
    /\ last' = Step("accept", s, i, TRUE)
    /\ UNCHANGED <<sessions, requests, data>>

(* Tenant statements: the request resolves its actor, and the statement   *)
(* runs later, after any number of other steps.                            *)

Resolve(r, s, kind) ==
    /\ requests[r].state = "idle"
    /\ sessions[s] = "live"
    /\ \E mine \in LiveSeats(s[1]) :
          /\ ResolveAdmits(kind, seats[mine].role)
          /\ requests' = [requests EXCEPT ![r] =
                [state |-> "resolved", session |-> s, ws |-> seats[mine].ws, kind |-> kind,
                 seat |-> mine, role |-> seats[mine].role, rev |-> seats[mine].rev]]
    /\ last' = Step("resolve", s, r, TRUE)
    /\ UNCHANGED <<seats, sessions, invitations, data>>

Run(r) ==
    LET q == requests[r]
        ok == Admits(q, seats[q.seat], sessions[q.session])
    IN
    /\ q.state = "resolved"
    /\ data' = IF q.kind = "write" /\ ok THEN [data EXCEPT ![q.ws] = 1 - @] ELSE data
    /\ requests' = [requests EXCEPT ![r] = Idle]
    /\ last' = Step(q.kind, q.session, r, ok)
    /\ UNCHANGED <<seats, sessions, invitations>>

Next ==
    \/ \E s \in SessionIds : SignIn(s) \/ EndSession(s)
    \/ \E s \in SessionIds, c \in SeatChanges, t \in SeatIds : SeatAction(s, c[1], c[2], t)
    \/ \E s \in SessionIds, i \in Invitations, w \in Workspaces, role \in Roles, to \in Others :
          Invite(s, i, w, role, to)
    \/ \E s \in SessionIds, i \in Invitations : Revoke(s, i) \/ Accept(s, i)
    \/ \E i \in Invitations : Expire(i)
    \/ \E r \in Requests, s \in SessionIds, kind \in StatementKinds : Resolve(r, s, kind)
    \/ \E r \in Requests : Run(r)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties. Letters follow the T-398 spec.                              *)

TypeOK ==
    /\ \A s \in SeatIds : seats[s].state \in {"unused", "live", "ended"}
    /\ \A s \in SessionIds : sessions[s] \in {"unused", "live", "ended"}
    /\ \A i \in Invitations : invitations[i].state \in {"unused"} \cup InvitationStates
    /\ \A w \in Workspaces : data[w] \in 0..1

\* seat_uq_0: an account holds at most one live seat.
OneLiveSeatPerAccount == \A a \in Accounts : Cardinality(LiveSeats(a)) <= 1

\* (a) A workspace never has more than one live owner (seat_uq_1, seat_uq_2).
OneLiveOwner ==
    \A w \in Workspaces :
        Cardinality({s \in SeatIds : seats[s].state = "live" /\ seats[s].ws = w /\ seats[s].role = "owner"}) <= 1

\* (a) No seat action changes or removes the owner seat.
OwnerSeatFixed ==
    [][\A t \in SeatIds : seats[t].role = "owner" => seats'[t] = seats[t]]_vars

\* (a) No invitation grants owner: none names it, and every owner seat is a founding seat.
NoInvitationGrantsOwner ==
    /\ \A i \in Invitations : invitations[i].state # "unused" => invitations[i].role # "owner"
    /\ \A t \in SeatIds : seats[t].role = "owner" => seats[t].inv = None

\* (b) Only a live Owner or Admin seat in the same workspace, on a live session,
\* changes a seat that exists; a member never does.
OnlyAdministratorsChangeSeats ==
    [][\A t \in SeatIds :
         (seats[t].state # "unused" /\ seats'[t] # seats[t]) =>
            /\ last'.op \in SeatOps
            /\ last'.target = t
            /\ sessions[last'.session] = "live"
            /\ \E mine \in LiveSeatIn(last'.session[1], seats[t].ws) : seats[mine].role \in Administrators]_vars

\* (b) No action applies to an ended seat.
NoActionOnEndedSeat ==
    [][/\ \A t \in SeatIds : seats[t].state = "ended" => seats'[t] = seats[t]
       /\ last'.op \in SeatOps => seats[last'.target].state = "live"]_vars

\* The request a step ran, if the step ran one.
RanRequest(r) == requests[r].state = "resolved" /\ requests'[r].state = "idle"

\* (c) No read or write in workspace A succeeds for an actor without a live seat in A.
TenantAccessNeedsSeat ==
    [][\A r \in Requests :
         (RanRequest(r) /\ last'.ok) => LiveSeatIn(requests[r].session[1], requests[r].ws) # {}]_vars

\* What a statement needs when it runs: the session it resolved is live, the seat
\* it resolved is live in that workspace and its role still grants the statement.
AccessHeld(q) ==
    /\ sessions[q.session] = "live"
    /\ seats[q.seat].state = "live"
    /\ seats[q.seat].ws = q.ws
    /\ (q.kind = "adminRead" => seats[q.seat].role \in Administrators)

\* (d) A statement that runs after the session ended, the seat ended or the role
\* lost the right returns no data, even though its request resolved the actor earlier.
StatementSeesLiveAccess ==
    [][\A r \in Requests : (RanRequest(r) /\ last'.ok) => AccessHeld(requests[r])]_vars

\* (d) ... and changes nothing.
NoChangeWithoutAccess ==
    [][data' # data =>
         \E r \in Requests : RanRequest(r) /\ requests[r].kind = "write" /\ AccessHeld(requests[r])]_vars

\* (e) An invitation is accepted at most once.
InvitationAcceptedOnce ==
    [][\A i \in Invitations : invitations[i].state = "accepted" => invitations'[i] = invitations[i]]_vars

\* (e) ... never after it expired or was revoked.
AcceptOnlyPending ==
    [][\A i \in Invitations :
         (invitations'[i].state = "accepted" /\ invitations[i].state # "accepted") =>
            invitations[i].state = "pending"]_vars

\* (e) Each acceptance yields exactly one seat, for the addressed account, in the
\* invitation's workspace.
OneSeatPerAcceptance ==
    \A i \in Invitations :
        LET made == {t \in SeatIds : seats[t].state # "unused" /\ seats[t].inv = i}
        IN /\ Cardinality(made) = IF invitations[i].state = "accepted" THEN 1 ELSE 0
           /\ \A t \in made : t[1] = invitations[i].to /\ seats[t].ws = invitations[i].ws

-----------------------------------------------------------------------------
(* The outcome table: what the rules above allow, row by row. The formal  *)
(* check prints it, writes outcomes.json and fails when that file is      *)
(* stale; the conformance test runs each row against the real operations. *)

Verdict(b) == IF b THEN "allow" ELSE "refuse"

SeatRows == {<<"seat", c[1], actor, target, c[2], Verdict(MayChangeSeat(c[1], actor, target, c[2]))>> :
               c \in SeatChanges, actor \in Roles, target \in Roles}
InviteRows == {<<"invite", inviter, role, Verdict(MayInvite(inviter, role))>> : inviter \in Roles, role \in Roles}
RevokeRows == {<<"revoke", actor, Verdict(MayRevoke(actor))>> : actor \in Roles}
AcceptRows == {<<"accept", state, IF seated THEN "seated" ELSE "seatless", role, Verdict(MayAccept(state, seated))>> :
                 state \in InvitationStates, seated \in BOOLEAN, role \in InvitableRoles}

\* What happens to the resolved seat between resolution and the statement. The
\* workspace owner makes each seat change, so only changes MayChangeSeat allows
\* the owner appear.
Events == {"none", "seat_removed", "session_ended", "demoted", "promoted"}
EventApplies(role, e) ==
    CASE e = "seat_removed" -> MayChangeSeat("remove", "owner", role, None)
      [] e = "demoted" -> MayChangeSeat("demote", "owner", role, "member")
      [] e = "promoted" -> role # "admin" /\ MayChangeSeat("appointAdmin", "owner", role, "admin")
      [] OTHER -> TRUE
After(seat, e) ==
    CASE e = "seat_removed" -> [seat EXCEPT !.state = "ended", !.rev = @ + 1]
      [] e = "demoted" -> [seat EXCEPT !.role = "member", !.rev = @ + 1]
      [] e = "promoted" -> [seat EXCEPT !.role = "admin", !.rev = @ + 1]
      [] OTHER -> seat
StatementOutcome(kind, role, e) ==
    LET seat == [state |-> "live", ws |-> "w", role |-> role, rev |-> 1, inv |-> None]
        q == [kind |-> kind, ws |-> "w", role |-> role, rev |-> 1]
        session == IF e \in {"seat_removed", "session_ended"} THEN "ended" ELSE "live"
    IN ResolveAdmits(kind, role) /\ Admits(q, After(seat, e), session)
\* The conformance test covers the reads; writes are model-checked only.
StatementRows == {<<"statement", p[1], p[2], p[3], Verdict(StatementOutcome(p[1], p[2], p[3]))>> :
                    p \in {t \in {"read", "adminRead"} \X Roles \X Events : EventApplies(t[2], t[3])}}

OutcomeRows == SeatRows \cup InviteRows \cup RevokeRows \cup AcceptRows \cup StatementRows

ASSUME PrintT(<<"outcomes", OutcomeRows>>)
=============================================================================
