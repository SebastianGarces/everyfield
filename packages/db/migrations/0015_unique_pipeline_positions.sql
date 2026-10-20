-- D68: every plant person gets a pipeline position no one else in the church shares, in the order each column shows
-- today (position, then creation time and ID). A pipeline move then always finds a key strictly between two
-- neighbours and changes one row. New, re-staged and restored people get fresh keys from the application.
UPDATE person p SET pipeline_position = r.n
FROM (
	SELECT id, row_number() OVER (
		PARTITION BY plant_id
		ORDER BY CASE WHEN stage IN ('core_group', 'launch_team', 'leader') THEN 'core_group' ELSE stage END,
			pipeline_position, created_at, id
	) AS n
	FROM person
	WHERE plant_id IS NOT NULL
) r
WHERE p.id = r.id;
