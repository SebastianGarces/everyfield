---------------------------- MODULE MCPermissions ----------------------------
(* The model TLC checks: two workspaces, each with its owner, and two other  *)
(* accounts.                                                                 *)
EXTENDS Permissions

CONSTANTS w1, w2, o1, o2, x, y

MCOwners == (w1 :> o1) @@ (w2 :> o2)
\* x starts as an Admin of w1 and y with no seat; invitations seat them anywhere.
MCStart == (x :> <<w1, "admin">>) @@ (y :> "none")
=============================================================================
