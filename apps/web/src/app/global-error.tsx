"use client";

// The last boundary: it replaces the root layout when that layout itself fails, so it renders its own document and
// imports nothing from the app. Its brand colours are the token values (design/handoff/tokens.css) written out, and the
// type falls back to system serifs and sans, because the stylesheet and next/font belong to the layout that failed.
const CSS = `
*{box-sizing:border-box;margin:0}
html{color-scheme:light;background:#FCFBF8}
body{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:#FCFBF8;
color:#181D19;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}
main{max-width:36rem}
.mark{font:400 22px/1 Georgia,"Times New Roman",serif;letter-spacing:-0.02em;margin-bottom:40px}
h1{font:400 clamp(36px,6vw,56px)/1.1 Georgia,"Times New Roman",serif;letter-spacing:-0.02em;text-wrap:balance}
p{margin-top:20px;font-size:18px;color:#4D5361;text-wrap:pretty}
.ref{margin-top:12px;font-size:15px;color:#666C78}
button{margin-top:36px;height:50px;padding:0 24px;border:0;border-radius:10px;background:#181D19;color:#F6F0E9;
font:600 17px/1 inherit;font-family:inherit;cursor:pointer}
button:hover{background:#343843}
button:focus-visible{outline:2px solid #181D19;outline-offset:3px}
`;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<html lang="en">
			<head>
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Something went wrong · Everyfield</title>
				<style dangerouslySetInnerHTML={{ __html: CSS }} />
			</head>
			<body>
				<main>
					<div className="mark">Everyfield</div>
					<h1>Something went wrong</h1>
					<p>Everyfield ran into a problem. Try again, and if it keeps happening, come back in a few minutes.</p>
					{error.digest ? <p className="ref">Error reference {error.digest}</p> : null}
					<button type="button" onClick={() => reset()}>
						Try again
					</button>
				</main>
			</body>
		</html>
	);
}
