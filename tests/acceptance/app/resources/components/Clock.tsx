// A module only a browser can read: it touches the window as it is loaded.
const opened = window.location.pathname;

export default function Clock({ label }: { label: string }) {
    return (
        <span data-testid="clock">
            {label} at {opened}
        </span>
    );
}
