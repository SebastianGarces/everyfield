# Document fonts

| File                                  | Family           | Use                                       | License                                 |
| ------------------------------------- | ---------------- | ----------------------------------------- | --------------------------------------- |
| `DMSerifDisplay-Regular.ttf`          | DM Serif Display | Document title only                       | `DMSerifDisplay-OFL.txt`                |
| `DMSans-{Regular,Medium,Bold}.ttf`    | DM Sans          | All other text                            | `DMSans-OFL.txt`                        |
| `DMSans-{Italic,BoldItalic}.ttf`      | DM Sans          | The `italic` mark of everyfield.doc/1     | `DMSans-OFL.txt`                        |
| `EFFigures-{Regular,Medium,Bold}.ttf` | EF Figures       | Times, dates and amounts in table columns | `DMSans-OFL.txt` (derived from DM Sans) |

`packages/domain/scripts/make-ef-figures.py` rebuilds EF Figures from DM Sans: it gives every digit the same advance.

The italic faces come from googlefonts/dm-fonts (`Sans/Exports/`), the same OFL release as the upright faces.
