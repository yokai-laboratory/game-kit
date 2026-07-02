import { NavLink } from "react-router-dom";
import { SHELL_TABS } from "../../shell.config";

// Floating glass capsule nav: frosted outer tray, solid inner pill, equal tabs. The active tab
// grows its icon, drops its label, and gets a slate pill. Tabs come from shell.config.tsx.
export function BottomNav(): React.JSX.Element {
    return (
        <div className="bottom-nav-tray">
            <nav className="bottom-nav" aria-label="Primary">
                {SHELL_TABS.map((item) => (
                    <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        className={({ isActive }) =>
                            `nav-tab${isActive ? " active" : ""}${item.primary ? " primary" : ""}`
                        }
                    >
                        <span className="pill" />
                        <span className="icon">{item.icon}</span>
                        <span className="label">{item.label}</span>
                    </NavLink>
                ))}
            </nav>
        </div>
    );
}
